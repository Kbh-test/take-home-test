import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Pool } from "pg";

import { closeTicket, listTickets, requeueTicket } from "../src/cli/commands";
import { withTransaction } from "../src/db/pool";
import { openTicket } from "../src/db/tickets";
import { canTransition, FORM_TRANSITIONS, JOB_TRANSITIONS } from "../src/db/transitions";
import { ingestForm } from "../src/ingest/ingest";
import type { FormStatus, JobStatus, JobType, ReasonCode } from "../src/types";
import { payloadWith } from "./fixtures/form";
import { countRows, createCleanup, createMigratedPool } from "./helpers/db";

type JobRow = {
	status: JobStatus;
	attempts: number;
	run_after: Date;
	locked_at: Date | null;
	last_error: string | null;
};

type TicketRow = {
	resolved_at: Date | null;
	resolved_by: string | null;
	resolution: string | null;
	resolution_note: string | null;
};

const { application_reference: _, ...withoutReference } = payloadWith();

const conflicting = payloadWith({ name: "Jane Doe" });

const execFileAsync = promisify(execFile);

const TSX = path.join(__dirname, "../node_modules/.bin/tsx");

const CLI = path.join(__dirname, "../src/cli/cli.ts");

describe("review ticket CLI", () => {
	const cleanup = createCleanup();
	let pool: Pool;

	beforeEach(async () => {
		pool = await createMigratedPool(cleanup);
	});

	afterEach(async () => {
		await cleanup.run();
	});

	const formIdOf = async (payload: unknown): Promise<string> => {
		const { rows } = await pool.query<{ id: string }>(
			"SELECT id FROM inbound_forms WHERE payload = $1::jsonb",
			[JSON.stringify(payload)],
		);
		return rows[0].id;
	};

	const ticketOf = async (formId: string): Promise<string> => {
		const { rows } = await pool.query<{ id: string }>(
			"SELECT id FROM dead_letters WHERE inbound_form_id = $1",
			[formId],
		);
		return rows[0].id;
	};

	const addTicket = (
		formId: string,
		reasonCode: ReasonCode,
		reason: string,
		jobId: string | null = null,
	) => withTransaction(pool, (client) => openTicket(client, formId, reasonCode, reason, jobId));

	const transformedForm = async () => {
		const payload = payloadWith({ application_reference: `GRU-${randomUUID()}` });

		await ingestForm(pool, payload);
		const formId = await formIdOf(payload);

		await pool.query("UPDATE inbound_forms SET status = 'transformed' WHERE id = $1", [formId]);
		const { rows } = await pool.query<{ id: string }>(
			"UPDATE jobs SET status = 'done', attempts = 1 WHERE inbound_form_id = $1 RETURNING id",
			[formId],
		);

		return { formId, processJobId: rows[0].id };
	};

	const insertJobTicket = async (
		type: Exclude<JobType, "process_form">,
		status: JobStatus = "dead",
	) => {
		const { formId } = await transformedForm();
		const job = await pool.query<{ id: string }>(
			`INSERT INTO jobs (inbound_form_id, type, status, attempts, run_after, last_error)
			VALUES ($1, $2, $3, 5, '2000-01-01T00:00:00Z', 'Provider returned 500') RETURNING id`,
			[formId, type, status],
		);
		const jobId = job.rows[0].id;

		await addTicket(
			formId,
			type === "deliver_formbot" ? "delivery_uncertain" : "job_failed",
			`${type} failed: Provider returned 500`,
			jobId,
		);

		return { formId, jobId, ticketId: await ticketOf(formId) };
	};

	const blockedProcessFormTicket = async (jobStatus: JobStatus) => {
		await ingestForm(pool, payloadWith());
		const formId = await formIdOf(payloadWith());

		await pool.query("UPDATE inbound_forms SET status = 'blocked' WHERE id = $1", [formId]);
		await pool.query(
			"UPDATE jobs SET status = $2, attempts = 1 WHERE inbound_form_id = $1",
			[formId, jobStatus],
		);
		await addTicket(formId, "validation_failed", "Validation failed: name has one word");

		return { formId, ticketId: await ticketOf(formId) };
	};

	const missingReferenceTicket = async () => {
		await ingestForm(pool, withoutReference);
		const formId = await formIdOf(withoutReference);

		return { formId, ticketId: await ticketOf(formId) };
	};

	const conflictTicket = async () => {
		await ingestForm(pool, payloadWith());
		await ingestForm(pool, conflicting);
		const acceptedId = await formIdOf(payloadWith());
		const formId = await formIdOf(conflicting);

		return { acceptedId, formId, ticketId: await ticketOf(formId) };
	};

	const formOf = async (formId: string) => {
		const { rows } = await pool.query<{
			status: FormStatus;
			application_reference: string | null;
			payload: unknown;
		}>("SELECT status, application_reference, payload FROM inbound_forms WHERE id = $1", [formId]);
		return rows[0];
	};

	const jobOf = async (jobId: string): Promise<JobRow> => {
		const { rows } = await pool.query<JobRow>(
			"SELECT status, attempts, run_after, locked_at, last_error FROM jobs WHERE id = $1",
			[jobId],
		);
		return rows[0];
	};

	const processJobOf = async (formId: string): Promise<JobRow> => {
		const { rows } = await pool.query<JobRow>(
			`SELECT status, attempts, run_after, locked_at, last_error FROM jobs
			WHERE inbound_form_id = $1 AND type = 'process_form'`,
			[formId],
		);
		return rows[0];
	};

	const ticketRow = async (ticketId: string): Promise<TicketRow> => {
		const { rows } = await pool.query<TicketRow>(
			"SELECT resolved_at, resolved_by, resolution, resolution_note FROM dead_letters WHERE id = $1",
			[ticketId],
		);
		return rows[0];
	};

	const snapshot = async () => {
		const forms = await pool.query("SELECT * FROM inbound_forms ORDER BY id");
		const jobs = await pool.query("SELECT * FROM jobs ORDER BY id");
		const tickets = await pool.query("SELECT * FROM dead_letters ORDER BY id");
		return { forms: forms.rows, jobs: jobs.rows, tickets: tickets.rows };
	};

	const requeued = {
		resolved_at: expect.any(Date),
		resolved_by: userInfo().username,
		resolution: "requeued",
		resolution_note: null,
	};

	const resetJob = {
		status: "pending",
		attempts: 0,
		locked_at: null,
	};

	const expectFreshRunAfter = (job: JobRow) => {
		expect(job.run_after.getTime()).toBeGreaterThan(Date.now() - 60_000);
	};

	it("lists open tickets oldest first and leaves out resolved ones", async () => {
		const missing = await missingReferenceTicket();
		const email = await insertJobTicket("send_email");
		const closed = await insertJobTicket("deliver_formbot");

		await pool.query(
			"UPDATE dead_letters SET created_at = created_at - interval '1 hour' WHERE id = $1",
			[email.ticketId],
		);
		await closeTicket(pool, closed.ticketId, "checked with FORM-BOT");

		expect(await listTickets(pool)).toEqual([
			{
				id: email.ticketId,
				createdAt: expect.any(Date),
				formId: email.formId,
				jobType: "send_email",
				reasonCode: "job_failed",
				reason: "send_email failed: Provider returned 500",
			},
			{
				id: missing.ticketId,
				createdAt: expect.any(Date),
				formId: missing.formId,
				jobType: null,
				reasonCode: "missing_reference",
				reason: "Missing application_reference",
			},
		]);
	});

	it("prints the reason code after the job type in list output", async () => {
		const missing = await missingReferenceTicket();
		const delivery = await insertJobTicket("deliver_formbot");

		const { stdout } = await execFileAsync(TSX, [CLI, "list"], {
			env: { ...process.env, DATABASE_URL: pool.options.connectionString },
		});

		expect(stdout.trimEnd().split("\n").map((line) => line.split("\t"))).toEqual([
			[
				missing.ticketId,
				expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				missing.formId,
				"form",
				"missing_reference",
				"Missing application_reference",
			],
			[
				delivery.ticketId,
				expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				delivery.formId,
				"deliver_formbot",
				"delivery_uncertain",
				"deliver_formbot failed: Provider returned 500",
			],
		]);
	});

	it("requeues a dead send_email job and resolves its ticket", async () => {
		const { formId, jobId, ticketId } = await insertJobTicket("send_email");

		await requeueTicket(pool, ticketId);

		const job = await jobOf(jobId);
		expect(job).toMatchObject({ ...resetJob, last_error: "Provider returned 500" });
		expectFreshRunAfter(job);
		expect(await ticketRow(ticketId)).toEqual(requeued);
		expect((await formOf(formId)).status).toBe("transformed");
	});

	it("refuses a dead deliver_formbot job without --confirm-not-delivered and changes nothing", async () => {
		const { ticketId } = await insertJobTicket("deliver_formbot");
		const before = await snapshot();

		await expect(requeueTicket(pool, ticketId)).rejects.toThrow(
			"verify it was not delivered, then rerun with --confirm-not-delivered",
		);
		expect(await snapshot()).toEqual(before);
	});

	it("requeues a dead deliver_formbot job with --confirm-not-delivered", async () => {
		const { jobId, ticketId } = await insertJobTicket("deliver_formbot");

		await requeueTicket(pool, ticketId, { confirmNotDelivered: true });

		expect(await jobOf(jobId)).toMatchObject(resetJob);
		expect(await ticketRow(ticketId)).toEqual(requeued);
	});

	it("refuses a missing-reference form while its payload has no application_reference", async () => {
		const { ticketId } = await missingReferenceTicket();
		const before = await snapshot();

		await expect(requeueTicket(pool, ticketId)).rejects.toThrow("no application_reference");
		expect(await snapshot()).toEqual(before);
	});

	it("refuses a conflict while the other submission is accepted", async () => {
		const { acceptedId, ticketId } = await conflictTicket();
		const before = await snapshot();

		await expect(requeueTicket(pool, ticketId)).rejects.toThrow(
			`another accepted submission holds the reference (form ${acceptedId})`,
		);
		expect(await snapshot()).toEqual(before);
	});

	it("requeues a conflict once the other submission is blocked", async () => {
		const { acceptedId, formId, ticketId } = await conflictTicket();

		await pool.query("UPDATE inbound_forms SET status = 'blocked' WHERE id = $1", [acceptedId]);
		await requeueTicket(pool, ticketId);

		expect(await formOf(formId)).toEqual({
			status: "received",
			application_reference: "GRU-123089-2026",
			payload: conflicting,
		});
		expect(await processJobOf(formId)).toMatchObject(resetJob);
		expect(await ticketRow(ticketId)).toEqual(requeued);
		expect(await countRows(pool)).toEqual({ forms: 2, jobs: 2, tickets: 1 });
	});

	it("requeues a validation-blocked form and resets its done process_form job", async () => {
		const { formId, ticketId } = await blockedProcessFormTicket("done");

		await requeueTicket(pool, ticketId);

		expect(await formOf(formId)).toEqual({
			status: "received",
			application_reference: "GRU-123089-2026",
			payload: payloadWith(),
		});
		const job = await processJobOf(formId);
		expect(job).toMatchObject(resetJob);
		expectFreshRunAfter(job);
		expect(await ticketRow(ticketId)).toEqual(requeued);
		expect(await countRows(pool)).toEqual({ forms: 1, jobs: 1, tickets: 1 });
	});

	it("refuses a job ticket whose job is done, even for process_form", async () => {
		const { formId, processJobId } = await transformedForm();

		await addTicket(formId, "job_failed", "process_form failed: Provider returned 500", processJobId);
		const ticketId = await ticketOf(formId);
		const before = await snapshot();

		await expect(requeueTicket(pool, ticketId)).rejects.toThrow(
			"job is done; only dead jobs can be requeued",
		);
		expect(await snapshot()).toEqual(before);
	});

	it("refuses a job ticket whose job is running", async () => {
		const { ticketId } = await insertJobTicket("send_email", "running");
		const before = await snapshot();

		await expect(requeueTicket(pool, ticketId)).rejects.toThrow(
			"job is running; only dead jobs can be requeued",
		);
		expect(await snapshot()).toEqual(before);
	});

	it("rolls back the form update when its process_form job is pending", async () => {
		const { ticketId } = await blockedProcessFormTicket("pending");
		const before = await snapshot();

		await expect(requeueTicket(pool, ticketId)).rejects.toThrow(
			"process_form job is pending; only dead or done process_form jobs can be reset",
		);
		expect(await snapshot()).toEqual(before);
	});

	it("rolls back the form update when its process_form job is running", async () => {
		const { ticketId } = await blockedProcessFormTicket("running");
		const before = await snapshot();

		await expect(requeueTicket(pool, ticketId)).rejects.toThrow(
			"process_form job is running; only dead or done process_form jobs can be reset",
		);
		expect(await snapshot()).toEqual(before);
	});

	it("refuses to requeue an already-resolved ticket", async () => {
		const { ticketId } = await insertJobTicket("send_email");

		await closeTicket(pool, ticketId, "duplicate email is fine");
		const before = await snapshot();

		await expect(requeueTicket(pool, ticketId)).rejects.toThrow(
			`ticket ${ticketId} is already resolved`,
		);
		expect(await snapshot()).toEqual(before);
	});

	it("refuses to close an already-resolved ticket", async () => {
		const { ticketId } = await insertJobTicket("send_email");

		await requeueTicket(pool, ticketId);
		const before = await snapshot();

		await expect(closeTicket(pool, ticketId, "too late")).rejects.toThrow(
			`ticket ${ticketId} is already resolved`,
		);
		expect(await snapshot()).toEqual(before);
	});

	it("refuses to requeue a ticket that does not exist", async () => {
		await expect(requeueTicket(pool, "999")).rejects.toThrow("ticket 999 not found");
	});

	it("refuses to close a ticket that does not exist", async () => {
		await expect(closeTicket(pool, "999", "nothing here")).rejects.toThrow(
			"ticket 999 not found",
		);
	});

	it("refuses to close without a note", async () => {
		const { ticketId } = await missingReferenceTicket();
		const before = await snapshot();

		await expect(closeTicket(pool, ticketId, "")).rejects.toThrow(
			"close needs a non-blank --note",
		);
		expect(await snapshot()).toEqual(before);
	});

	it("refuses to close with a blank note", async () => {
		const { ticketId } = await missingReferenceTicket();
		const before = await snapshot();

		await expect(closeTicket(pool, ticketId, " \t\n ")).rejects.toThrow(
			"close needs a non-blank --note",
		);
		expect(await snapshot()).toEqual(before);
	});

	it("closes a ticket with a trimmed note and leaves its form and job untouched", async () => {
		const { ticketId } = await insertJobTicket("deliver_formbot");
		const { forms, jobs } = await snapshot();

		await closeTicket(pool, ticketId, "  FORM-BOT confirmed receipt  ");

		expect(await ticketRow(ticketId)).toEqual({
			resolved_at: expect.any(Date),
			resolved_by: userInfo().username,
			resolution: "closed",
			resolution_note: "FORM-BOT confirmed receipt",
		});
		const after = await snapshot();
		expect(after.forms).toEqual(forms);
		expect(after.jobs).toEqual(jobs);
	});
});

describe("status transition maps", () => {
	it("allows exactly the agreed moves for every from/to pair", () => {
		const jobStatuses: JobStatus[] = ["pending", "running", "done", "dead"];
		const formStatuses: FormStatus[] = ["received", "transformed", "blocked"];
		const allowed = <S extends string>(statuses: S[], map: Record<S, readonly S[]>) =>
			statuses.flatMap((from) =>
				statuses.filter((to) => canTransition(map, from, to)).map((to) => `${from} -> ${to}`),
			);

		expect(allowed(jobStatuses, JOB_TRANSITIONS).sort()).toEqual(
			[
				"pending -> running",
				"running -> done",
				"running -> pending",
				"running -> dead",
				"dead -> pending",
				"done -> pending",
			].sort(),
		);
		expect(allowed(formStatuses, FORM_TRANSITIONS).sort()).toEqual(
			["received -> transformed", "received -> blocked", "blocked -> received"].sort(),
		);
	});
});
