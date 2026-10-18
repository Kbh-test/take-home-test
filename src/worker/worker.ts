import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";

import { claimJob, completeJob, killJob, recoverJobs, retryJob } from "../db/jobs";
import { WORKER_LOCK_ID } from "../db/locks";
import { DB_TIMEOUTS } from "../db/pool";
import { DEFAULT_ATTEMPT_LIMIT, errorMessage } from "../helpers";
import { JobError } from "../jobs/provider";
import type { Job, JobType } from "../types";
import type { Worker, WorkerOptions } from "./types";

export const MAX_ATTEMPTS: Record<JobType, number> = {
	process_form: DEFAULT_ATTEMPT_LIMIT,
	send_email: DEFAULT_ATTEMPT_LIMIT,
	deliver_formbot: 1,
};

export function backoffWithJitter(attempts: number): number {
	const ceiling = Math.min(1_000 * 2 ** attempts, 5 * 60_000);

	return ceiling / 2 + Math.random() * (ceiling / 2);
}

function safeMessage(error: unknown): string {
	return error instanceof JobError ? error.message : "Unexpected error; see worker logs";
}

async function takeWorkerLock(connectionString: string): Promise<Client | null> {
	const client = new Client({ connectionString, ...DB_TIMEOUTS });

	try {
		await client.connect();

		const { rows } = await client.query<{ locked: boolean }>(
			"SELECT pg_try_advisory_lock($1) AS locked",
			[WORKER_LOCK_ID],
		);

		if (rows[0].locked) {
			return client;
		}
	} catch (error) {
		await client.end().catch(() => undefined);
		throw error;
	}

	await client.end();
	return null;
}

export async function startWorker({
	pool,
	connectionString,
	handlers,
	pollIntervalMs = 1_000,
	retryDelayMs = backoffWithJitter,
	maxAttempts = {},
}: WorkerOptions): Promise<Worker | null> {
	const lockClient = await takeWorkerLock(connectionString);

	if (!lockClient) {
		console.error("Worker not started: another worker holds the lock");
		return null;
	}

	let stopping = false;
	let lockLost = false;

	lockClient.on("error", (error) => {
		console.error("Worker lock connection lost:", error.message);
		lockLost = true;
	});

	const failJob = (job: Job, error: unknown): Promise<boolean> => {
		console.error(`Job ${job.id} (${job.type}) failed:`, errorMessage(error));

		const limit =
			job.type === "deliver_formbot"
				? MAX_ATTEMPTS.deliver_formbot
				: maxAttempts[job.type] ?? MAX_ATTEMPTS[job.type];

		if (job.attempts >= limit) {
			return killJob(pool, job, safeMessage(error));
		}

		return retryJob(pool, job, safeMessage(error), retryDelayMs(job.attempts));
	};

	const runJob = async (job: Job): Promise<void> => {
		let failure: { error: unknown } | undefined;

		try {
			await handlers[job.type](pool, job.inboundFormId);
		} catch (error) {
			failure = { error };
		}

		if (lockLost) {
			return;
		}

		const moved = failure ? await failJob(job, failure.error) : await completeJob(pool, job);

		if (!moved) {
			console.error(`Job ${job.id} was no longer running; left unchanged`);
		}
	};

	const loop = async (): Promise<void> => {
		let needsRecovery = true;

		try {
			while (!stopping && !lockLost) {
				try {
					if (needsRecovery) {
						await recoverJobs(pool);
						needsRecovery = false;
					}

					const job = await claimJob(pool);

					if (job && !lockLost) {
						await runJob(job);
						continue;
					}
				} catch (error) {
					console.error("Worker iteration failed; recovering:", errorMessage(error));
					needsRecovery = true;
				}

				await sleep(pollIntervalMs);
			}
		} finally {
			await lockClient.end().catch(() => undefined);
		}
	};

	const stopped = loop();

	return {
		stopped,
		stop: async () => {
			stopping = true;
			await stopped;
		},
	};
}
