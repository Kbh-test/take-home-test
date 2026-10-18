import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Pool } from "pg";

import { claimJob, completeJob, recoverJobs } from "../src/db/jobs";
import { callProvider, JobError } from "../src/jobs/provider";
import type { Job, JobStatus, JobType } from "../src/types";
import type { JobHandler, Worker } from "../src/worker/types";
import { MAX_ATTEMPTS, startWorker } from "../src/worker/worker";
import { createCleanup, createMigratedPool } from "./helpers/db";

type JobRow = {
	status: JobStatus;
	attempts: number;
	last_error: string | null;
	locked_at: Date | null;
	run_after: Date;
};

const providerError = new JobError("Provider returned 500");

const mockHandler = () => jest.fn<Promise<void>, [Pool, string]>().mockResolvedValue(undefined);

describe("worker", () => {
	const cleanup = createCleanup();
	let pool: Pool;

	beforeEach(async () => {
		jest.spyOn(console, "error").mockImplementation(() => undefined);
		pool = await createMigratedPool(cleanup);
	});

	afterEach(async () => {
		await cleanup.run();
		jest.restoreAllMocks();
	});

	const start = async (
		handlers: Partial<Record<JobType, JobHandler>> = {},
		retryDelayMs = 0,
	): Promise<Worker | null> => {
		const worker = await startWorker({
			pool,
			connectionString: pool.options.connectionString!,
			handlers: {
				process_form: mockHandler(),
				send_email: mockHandler(),
				deliver_formbot: mockHandler(),
				...handlers,
			},
			pollIntervalMs: 10,
			retryDelayMs: () => retryDelayMs,
		});

		return worker && cleanup.track(worker, (w) => w.stop());
	};

	const insertJob = async (type: JobType, status = "pending") => {
		const form = await pool.query<{ id: string }>(
			"INSERT INTO inbound_forms (payload, status) VALUES ($1::jsonb, 'received') RETURNING id",
			[JSON.stringify({ id: randomUUID() })],
		);
		const job = await pool.query<{ id: string }>(
			"INSERT INTO jobs (inbound_form_id, type, status) VALUES ($1, $2, $3) RETURNING id",
			[form.rows[0].id, type, status],
		);

		return { formId: form.rows[0].id, jobId: job.rows[0].id };
	};

	const jobRow = async (jobId: string): Promise<JobRow> => {
		const { rows } = await pool.query<JobRow>(
			"SELECT status, attempts, last_error, locked_at, run_after FROM jobs WHERE id = $1",
			[jobId],
		);
		return rows[0];
	};

	const tickets = async () => {
		const { rows } = await pool.query("SELECT inbound_form_id, job_id, reason FROM dead_letters");
		return rows;
	};

	const waitForJob = async (jobId: string, matches: (row: JobRow) => boolean): Promise<JobRow> => {
		for (let i = 0; i < 200; i++) {
			const row = await jobRow(jobId);
			if (matches(row)) {
				return row;
			}
			await sleep(10);
		}
		throw new Error(`Job ${jobId} never reached the expected state`);
	};

	const waitForStatus = (jobId: string, status: JobStatus) =>
		waitForJob(jobId, (row) => row.status === status);

	const terminateWorkerLock = async () => {
		await pool.query(
			`SELECT pg_terminate_backend(pid) FROM pg_locks
			WHERE locktype = 'advisory'
				AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
		);
		await sleep(50);
	};

	const beforeQuery = (sqlFragment: string, intercept: () => Promise<void>) => {
		const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;

		jest.spyOn(pool, "query").mockImplementation((async (...args: unknown[]) => {
			if (String(args[0]).includes(sqlFragment)) {
				await intercept();
			}
			return query(...args);
		}) as never);
	};

	it("runs a pending job and marks it done", async () => {
		const { formId, jobId } = await insertJob("send_email");
		const sendEmail = mockHandler();

		await start({ send_email: sendEmail });

		expect(await waitForStatus(jobId, "done")).toMatchObject({ attempts: 1, locked_at: null });
		expect(sendEmail).toHaveBeenCalledTimes(1);
		expect(sendEmail).toHaveBeenCalledWith(pool, formId);
	});

	it("saves running and locked_at before calling the handler", async () => {
		const { jobId } = await insertJob("deliver_formbot");
		let seen: JobRow | undefined;

		await start({
			deliver_formbot: mockHandler().mockImplementation(async () => {
				seen = await jobRow(jobId);
			}),
		});

		await waitForStatus(jobId, "done");
		expect(seen?.status).toBe("running");
		expect(seen?.locked_at).toBeInstanceOf(Date);
	});

	it("retries a failed job until it succeeds", async () => {
		const { jobId } = await insertJob("send_email");
		const sendEmail = mockHandler()
			.mockRejectedValueOnce(providerError)
			.mockRejectedValueOnce(providerError);

		await start({ send_email: sendEmail });

		expect(await waitForStatus(jobId, "done")).toMatchObject({
			attempts: 3,
			last_error: "Provider returned 500",
		});
		expect(sendEmail).toHaveBeenCalledTimes(3);
	});

	it("marks a job dead with one ticket after the retry limit", async () => {
		const { formId, jobId } = await insertJob("send_email");
		const sendEmail = mockHandler().mockRejectedValue(providerError);

		await start({ send_email: sendEmail });

		expect(await waitForStatus(jobId, "dead")).toMatchObject({
			attempts: MAX_ATTEMPTS.send_email,
			last_error: "Provider returned 500",
		});
		expect(sendEmail).toHaveBeenCalledTimes(MAX_ATTEMPTS.send_email);
		expect(await tickets()).toEqual([
			{ inbound_form_id: formId, job_id: jobId, reason: "send_email failed: Provider returned 500" },
		]);
	});

	it("never retries a failed FORM-BOT delivery", async () => {
		const { jobId } = await insertJob("deliver_formbot");
		const formBot = mockHandler().mockRejectedValue(providerError);

		await start({ deliver_formbot: formBot });

		await waitForStatus(jobId, "dead");
		expect(formBot).toHaveBeenCalledTimes(1);
		expect(await tickets()).toHaveLength(1);
	});

	it("stores a generic message instead of an unexpected error's text", async () => {
		const { jobId } = await insertJob("deliver_formbot");
		const formBot = mockHandler().mockRejectedValue(
			new Error('duplicate key value violates unique constraint: (application_reference)=(GRU-123089-2026)'),
		);

		await start({ deliver_formbot: formBot });

		expect(await waitForStatus(jobId, "dead")).toMatchObject({
			last_error: "Unexpected error; see worker logs",
		});
		expect(await tickets()).toMatchObject([
			{ reason: "deliver_formbot failed: Unexpected error; see worker logs" },
		]);
	});

	it("waits for the backoff before retrying a failed job", async () => {
		const { jobId } = await insertJob("send_email");

		await start({ send_email: mockHandler().mockRejectedValue(providerError) }, 60_000);

		const row = await waitForJob(jobId, (job) => job.last_error !== null);
		expect(row).toMatchObject({ status: "pending", attempts: 1, last_error: "Provider returned 500" });
		expect(row.run_after.getTime()).toBeGreaterThan(Date.now() + 50_000);
	});

	it("retries after a provider timeout without overlapping attempts", async () => {
		const { jobId } = await insertJob("process_form");
		let active = 0;
		let maxActive = 0;

		const processForm = mockHandler().mockImplementation(async () => {
			active++;
			maxActive = Math.max(maxActive, active);

			try {
				if (processForm.mock.calls.length === 1) {
					await callProvider("Geocoder", (signal) => sleep(10_000, { statusCode: 200 }, { signal }), 50);
				}
			} finally {
				active--;
			}
		});

		await start({ process_form: processForm });

		expect(await waitForStatus(jobId, "done")).toMatchObject({
			attempts: 2,
			last_error: "Geocoder timed out after 50ms",
		});
		expect(processForm).toHaveBeenCalledTimes(2);
		expect(maxActive).toBe(1);
	});

	it("finishes the active job on shutdown and claims no more", async () => {
		const first = await insertJob("send_email");
		const second = await insertJob("send_email");

		let enterHandler!: () => void;
		let releaseHandler!: () => void;
		const handlerEntered = new Promise<void>((resolve) => {
			enterHandler = resolve;
		});
		const handlerReleased = new Promise<void>((resolve) => {
			releaseHandler = resolve;
		});

		const worker = await start({
			send_email: mockHandler().mockImplementation(async () => {
				enterHandler();
				await handlerReleased;
			}),
		});
		await handlerEntered;
		const stopped = worker!.stop();
		releaseHandler();
		await stopped;

		expect((await jobRow(first.jobId)).status).toBe("done");
		expect((await jobRow(second.jobId)).status).toBe("pending");
	});

	it("rejects a status write from a stale attempt", async () => {
		await insertJob("send_email");

		const stale = (await claimJob(pool)) as Job;
		await recoverJobs(pool);
		const current = (await claimJob(pool)) as Job;

		expect(stale.attempts).toBe(1);
		expect(current.attempts).toBe(2);
		expect(await completeJob(pool, stale)).toBe(false);
		expect(await completeJob(pool, current)).toBe(true);
	});

	it("runs one job at a time", async () => {
		const jobs = [await insertJob("send_email"), await insertJob("send_email"), await insertJob("send_email")];
		let active = 0;
		let maxActive = 0;

		await start({
			send_email: mockHandler().mockImplementation(async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				await sleep(20);
				active--;
			}),
		});

		for (const { jobId } of jobs) {
			await waitForStatus(jobId, "done");
		}
		expect(maxActive).toBe(1);
	});

	it("resumes interrupted jobs on restart but never redelivers to FORM-BOT", async () => {
		const processForm = await insertJob("process_form", "running");
		const sendEmail = await insertJob("send_email", "running");
		const delivery = await insertJob("deliver_formbot", "running");
		const formBot = mockHandler();

		await start({ deliver_formbot: formBot });

		await waitForStatus(processForm.jobId, "done");
		await waitForStatus(sendEmail.jobId, "done");
		expect(await jobRow(delivery.jobId)).toMatchObject({ status: "dead", locked_at: null });
		expect(formBot).not.toHaveBeenCalled();
		expect(await tickets()).toEqual([
			{
				inbound_form_id: delivery.formId,
				job_id: delivery.jobId,
				reason: "deliver_formbot was interrupted before its result was saved; check FORM-BOT before requeueing",
			},
		]);
	});

	it("recovers a job whose completion could not be saved", async () => {
		const { jobId } = await insertJob("send_email");
		const sendEmail = mockHandler();
		let failed = false;

		beforeQuery("SET status = 'done'", async () => {
			if (!failed) {
				failed = true;
				throw new Error("connection reset");
			}
		});

		await start({ send_email: sendEmail });

		expect(await waitForStatus(jobId, "done")).toMatchObject({ attempts: 2 });
		expect(sendEmail).toHaveBeenCalledTimes(2);
	});

	it("does not start while another worker holds the lock", async () => {
		expect(await start()).not.toBeNull();
		expect(await start()).toBeNull();
	});

	it("stops claiming jobs when its lock connection is lost", async () => {
		const worker = await start();

		await terminateWorkerLock();
		await worker!.stopped;

		const { jobId } = await insertJob("send_email");
		await sleep(50);
		expect((await jobRow(jobId)).status).toBe("pending");
	});

	it("does not call the handler when the lock is lost while claiming", async () => {
		const { jobId } = await insertJob("deliver_formbot");
		const formBot = mockHandler();

		beforeQuery("SET status = 'running'", terminateWorkerLock);
		const worker = await start({ deliver_formbot: formBot });
		await worker!.stopped;

		expect(formBot).not.toHaveBeenCalled();
		expect((await jobRow(jobId)).status).toBe("running");
	});

	it("leaves an in-flight job for restart recovery when the lock is lost", async () => {
		const { jobId } = await insertJob("deliver_formbot");

		const worker = await start({ deliver_formbot: mockHandler().mockImplementation(terminateWorkerLock) });
		await worker!.stopped;

		expect(await jobRow(jobId)).toMatchObject({ status: "running", attempts: 1 });
	});
});
