import { setTimeout as sleep } from "node:timers/promises";
import type { Pool } from "pg";

import { requeueTicket } from "../src/cli/commands";
import { findTransformedForm } from "../src/db/transformed_forms";
import * as transformModule from "../src/forms/transform";
import { ingestForm } from "../src/ingest/ingest";
import { deliverToFormBot } from "../src/jobs/deliver_formbot";
import { processForm } from "../src/jobs/process_form";
import { sendFormEmail } from "../src/jobs/send_email";
import type { deliverForm } from "../src/providers/formbot";
import type { lookupPostcode } from "../src/providers/idealpostcodes";
import type { sendEmail } from "../src/providers/sendgrid";
import type { JobType } from "../src/types";
import type { Worker } from "../src/worker/types";
import { startWorker } from "../src/worker/worker";
import { payloadWith } from "./fixtures/form";
import { countRows, createCleanup, createMigratedPool } from "./helpers/db";

type JobState = {
	type: JobType;
	status: string;
	attempts: number;
	last_error: string | null;
};

type FormState = {
	status: string;
	tickets: number;
	jobs: JobState[];
};

const coordinates = { latitude: -5.05, longitude: 50.05 };

const WAIT_TIMEOUT_MS = 3_000;

const allJobsDone = (state: FormState, count: number) =>
	state.jobs.length === count && state.jobs.every((job) => job.status === "done");

const withEmailFromWorkEmail = (payload: unknown): unknown => {
	if (typeof payload !== "object" || payload === null || "email" in payload || !("work_email" in payload)) {
		return payload;
	}

	const { work_email, ...rest } = payload as Record<string, unknown>;

	return { ...rest, email: work_email };
};

describe("integration scenarios", () => {
	const cleanup = createCleanup();
	let pool: Pool;
	let geocode: jest.MockedFunction<typeof lookupPostcode>;
	let send: jest.MockedFunction<typeof sendEmail>;
	let deliver: jest.MockedFunction<typeof deliverForm>;

	beforeEach(async () => {
		jest.spyOn(console, "error").mockImplementation(() => undefined);
		pool = await createMigratedPool(cleanup);
		geocode = jest.fn().mockResolvedValue({ statusCode: 200, body: coordinates });
		send = jest.fn().mockResolvedValue({ statusCode: 202 });
		deliver = jest.fn().mockResolvedValue({ statusCode: 204 });
	});

	afterEach(async () => {
		try {
			await cleanup.run();
		} finally {
			jest.restoreAllMocks();
		}
	});

	const start = async (): Promise<Worker> => {
		const worker = await startWorker({
			pool,
			connectionString: pool.options.connectionString!,
			handlers: {
				process_form: (p, formId) => processForm(p, formId, geocode),
				send_email: (p, formId) => sendFormEmail(p, formId, send),
				deliver_formbot: (p, formId) => deliverToFormBot(p, formId, deliver),
			},
			pollIntervalMs: 10,
			retryDelayMs: () => 0,
		});

		expect(worker).not.toBeNull();
		return cleanup.track(worker!, (w) => w.stop());
	};

	const ingest = async (payload: unknown): Promise<string> => {
		await ingestForm(pool, payload);
		const { rows } = await pool.query<{ id: string }>(
			"SELECT id FROM inbound_forms WHERE payload_hash = payload_sha256($1::jsonb)",
			[JSON.stringify(payload)],
		);
		return rows[0].id;
	};

	const formState = async (formId: string): Promise<FormState> => {
		const form = await pool.query<{ status: string; tickets: number }>(
			`SELECT status, (SELECT count(*)::int FROM dead_letters WHERE inbound_form_id = $1) AS tickets
			FROM inbound_forms WHERE id = $1`,
			[formId],
		);
		const jobs = await pool.query<JobState>(
			"SELECT type, status, attempts, last_error FROM jobs WHERE inbound_form_id = $1 ORDER BY id",
			[formId],
		);

		return { ...form.rows[0], jobs: jobs.rows };
	};

	const waitForState = async (formId: string, reached: (state: FormState) => boolean): Promise<FormState> => {
		const deadline = Date.now() + WAIT_TIMEOUT_MS;
		let state = await formState(formId);

		while (!reached(state)) {
			if (Date.now() > deadline) {
				throw new Error(`Form ${formId} did not reach the expected state; observed ${JSON.stringify(state)}`);
			}
			await sleep(10);
			state = await formState(formId);
		}

		return state;
	};

	const storedPayload = async (formId: string): Promise<unknown> => {
		const { rows } = await pool.query("SELECT payload FROM inbound_forms WHERE id = $1", [formId]);
		return rows[0].payload;
	};

	const ticketsOf = async (formId: string) => {
		const { rows } = await pool.query<{
			id: string;
			job_id: string | null;
			reason: string;
			resolved_at: Date | null;
			resolution: string | null;
		}>(
			"SELECT id, job_id, reason, resolved_at, resolution FROM dead_letters WHERE inbound_form_id = $1 ORDER BY id",
			[formId],
		);
		return rows;
	};

	const transformedRowCount = async (): Promise<number> => {
		const { rows } = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM transformed_forms");
		return rows[0].count;
	};

	it("replays a schema-drift form after a mapper fix without changing its stored payload", async () => {
		const { email, ...rest } = payloadWith();
		const driftPayload = { ...rest, work_email: email };
		const formId = await ingest(driftPayload);

		const firstWorker = await start();
		const blocked = await waitForState(
			formId,
			(state) => state.status === "blocked" && state.tickets === 1 && allJobsDone(state, 1),
		);
		await firstWorker.stop();

		const [ticket, ...otherTickets] = await ticketsOf(formId);
		expect(otherTickets).toStrictEqual([]);
		expect(ticket).toMatchObject({ job_id: null, resolved_at: null, resolution: null });
		expect(ticket.reason).toBe("Validation failed: email is missing");
		expect(blocked.jobs.map(({ type }) => type)).toStrictEqual(["process_form"]);
		expect(await transformedRowCount()).toBe(0);
		expect(geocode).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(deliver).not.toHaveBeenCalled();
		expect(await storedPayload(formId)).toStrictEqual(driftPayload);

		const originalTransform = transformModule.transform;
		jest
			.spyOn(transformModule, "transform")
			.mockImplementation((payload) => originalTransform(withEmailFromWorkEmail(payload)));

		await requeueTicket(pool, ticket.id);
		const secondWorker = await start();
		const replayed = await waitForState(formId, (state) => allJobsDone(state, 3));
		await secondWorker.stop();

		expect(replayed.status).toBe("transformed");
		expect((await findTransformedForm(pool, formId))?.email).toBe(email);
		expect(geocode).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledTimes(1);
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(await transformedRowCount()).toBe(1);
		expect(await ticketsOf(formId)).toStrictEqual([
			{ ...ticket, resolved_at: expect.any(Date), resolution: "requeued" },
		]);
		expect(await countRows(pool)).toStrictEqual({ forms: 1, jobs: 3, tickets: 1 });
		expect(await storedPayload(formId)).toStrictEqual(driftPayload);
	});

	it("retries geocoder and email failures without repeating completed stages", async () => {
		geocode.mockResolvedValueOnce({ statusCode: 500 });
		send.mockResolvedValueOnce({ statusCode: 500 });
		const formId = await ingest(payloadWith());

		const worker = await start();
		const { status, jobs } = await waitForState(formId, (state) => allJobsDone(state, 3));
		await worker.stop();

		expect(status).toBe("transformed");
		expect(Object.fromEntries(jobs.map(({ type, attempts }) => [type, attempts]))).toStrictEqual({
			process_form: 2,
			send_email: 2,
			deliver_formbot: 1,
		});
		expect(geocode).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenCalledTimes(2);
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(await transformedRowCount()).toBe(1);
		expect(await countRows(pool)).toStrictEqual({ forms: 1, jobs: 3, tickets: 0 });
	});
});
