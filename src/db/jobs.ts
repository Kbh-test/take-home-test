import type { Pool } from "pg";

import type { Job } from "../types";
import { withTransaction } from "./pool";
import { openTicket } from "./tickets";

const INTERRUPTED_DELIVERY =
	"deliver_formbot was interrupted before its result was saved; check FORM-BOT before requeueing";

export async function claimJob(pool: Pool): Promise<Job | null> {
	const { rows } = await pool.query<Job>(
		`UPDATE jobs
		SET status = 'running', locked_at = now(), attempts = attempts + 1
		WHERE id = (
			SELECT id FROM jobs
			WHERE status = 'pending' AND run_after <= now()
			ORDER BY run_after, id
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		RETURNING id, inbound_form_id AS "inboundFormId", type, attempts`,
	);

	return rows[0] ?? null;
}

export async function completeJob(pool: Pool, job: Job): Promise<boolean> {
	const { rowCount } = await pool.query(
		`UPDATE jobs SET status = 'done', locked_at = NULL
		WHERE id = $1 AND status = 'running' AND attempts = $2`,
		[job.id, job.attempts],
	);

	return rowCount === 1;
}

export async function retryJob(
	pool: Pool,
	job: Job,
	error: string,
	delayMs: number,
): Promise<boolean> {
	const { rowCount } = await pool.query(
		`UPDATE jobs
		SET status = 'pending', locked_at = NULL, last_error = $2,
			run_after = now() + make_interval(secs => $3)
		WHERE id = $1 AND status = 'running' AND attempts = $4`,
		[job.id, error, delayMs / 1_000, job.attempts],
	);

	return rowCount === 1;
}

export function killJob(pool: Pool, job: Job, error: string): Promise<boolean> {
	return withTransaction(pool, async (client) => {
		const { rowCount } = await client.query(
			`UPDATE jobs SET status = 'dead', locked_at = NULL, last_error = $2
			WHERE id = $1 AND status = 'running' AND attempts = $3`,
			[job.id, error, job.attempts],
		);

		if (rowCount !== 1) {
			return false;
		}

		await openTicket(client, job.inboundFormId, `${job.type} failed: ${error}`, job.id);
		return true;
	});
}

export function recoverJobs(pool: Pool): Promise<void> {
	return withTransaction(pool, async (client) => {
		await client.query(
			`UPDATE jobs SET status = 'pending', locked_at = NULL
			WHERE status = 'running' AND type IN ('process_form', 'send_email')`,
		);

		await client.query(
			`WITH interrupted AS (
				UPDATE jobs SET status = 'dead', locked_at = NULL, last_error = $1
				WHERE status = 'running' AND type = 'deliver_formbot'
				RETURNING id, inbound_form_id
			)
			INSERT INTO dead_letters (inbound_form_id, job_id, reason)
			SELECT inbound_form_id, id, $1 FROM interrupted`,
			[INTERRUPTED_DELIVERY],
		);
	});
}
