import type { Pool } from "pg";

import { requeueTicket } from "../src/cli/commands";
import { findTransformedForm } from "../src/db/transformed_forms";
import * as transformModule from "../src/forms/transform";
import type { FormStatus, JobStatus, JobType } from "../src/types";
import { payloadWith } from "./fixtures/form";
import { countRows, createCleanup, createMigratedPool, ingestAndGetId } from "./helpers/db";
import { waitUntil } from "./helpers/wait";
import { fakeProviders, startPipelineWorker } from "./helpers/worker";

type JobState = {
	type: JobType;
	status: JobStatus;
	attempts: number;
	last_error: string | null;
};

type FormState = {
	status: FormStatus;
	tickets: number;
	jobs: JobState[];
};

const WAIT_TIMEOUT_MS = 3_000;

const allJobsDone = (state: FormState, count: number) =>
	state.jobs.length === count && state.jobs.every((job) => job.status === "done");

const withEmailFromWorkEmail = (payload: unknown): unknown => {
	if (
		typeof payload !== "object" ||
		payload === null ||
		"email" in payload ||
		!("work_email" in payload)
	) {
		return payload;
	}

	const { work_email, ...rest } = payload as Record<string, unknown>;

	return { ...rest, email: work_email };
};

describe("integration scenarios", () => {
	const cleanup = createCleanup();
	let pool: Pool;
	let providers: ReturnType<typeof fakeProviders>;

	beforeEach(async () => {
		jest.spyOn(console, "error").mockImplementation(() => undefined);
		pool = await createMigratedPool(cleanup);
		providers = fakeProviders();
	});

	afterEach(async () => {
		try {
			await cleanup.run();
		} finally {
			jest.restoreAllMocks();
		}
	});

	const formState = async (formId: string): Promise<FormState> => {
		const form = await pool.query<{ status: FormStatus; tickets: number }>(
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

	const waitForState = (formId: string, reached: (state: FormState) => boolean): Promise<FormState> =>
		waitUntil(() => formState(formId), reached, `Form ${formId}`, {
			intervalMs: 10,
			timeoutMs: WAIT_TIMEOUT_MS,
		});

	const storedPayload = async (formId: string): Promise<unknown> => {
		const { rows } = await pool.query("SELECT payload FROM inbound_forms WHERE id = $1", [formId]);
		return rows[0].payload;
	};

	const ticketsOf = async (formId: string) => {
		const { rows } = await pool.query<{
			id: string;
			job_id: string | null;
			reason_code: string;
			reason: string;
			resolved_at: Date | null;
			resolution: string | null;
		}>(
			"SELECT id, job_id, reason_code, reason, resolved_at, resolution FROM dead_letters WHERE inbound_form_id = $1 ORDER BY id",
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
		const formId = await ingestAndGetId(pool, driftPayload);

		const firstWorker = await startPipelineWorker(pool, cleanup, providers);
		const blocked = await waitForState(
			formId,
			(state) => state.status === "blocked" && state.tickets === 1 && allJobsDone(state, 1),
		);
		await firstWorker.stop();

		const [ticket, ...otherTickets] = await ticketsOf(formId);
		expect(otherTickets).toStrictEqual([]);
		expect(ticket).toMatchObject({ job_id: null, resolved_at: null, resolution: null });
		expect(ticket.reason_code).toBe("validation_failed");
		expect(ticket.reason).toBe("Validation failed: email is missing");
		expect(blocked.jobs.map(({ type }) => type)).toStrictEqual(["process_form"]);
		expect(await transformedRowCount()).toBe(0);
		expect(providers.geocode).not.toHaveBeenCalled();
		expect(providers.send).not.toHaveBeenCalled();
		expect(providers.deliver).not.toHaveBeenCalled();
		expect(await storedPayload(formId)).toStrictEqual(driftPayload);

		const originalTransform = transformModule.transform;
		jest
			.spyOn(transformModule, "transform")
			.mockImplementation((payload) => originalTransform(withEmailFromWorkEmail(payload)));

		await requeueTicket(pool, ticket.id);
		const secondWorker = await startPipelineWorker(pool, cleanup, providers);
		const replayed = await waitForState(formId, (state) => allJobsDone(state, 3));
		await secondWorker.stop();

		expect(replayed.status).toBe("transformed");
		expect((await findTransformedForm(pool, formId))?.email).toBe(email);
		expect(providers.geocode).toHaveBeenCalledTimes(1);
		expect(providers.send).toHaveBeenCalledTimes(1);
		expect(providers.deliver).toHaveBeenCalledTimes(1);
		expect(await transformedRowCount()).toBe(1);
		expect(await ticketsOf(formId)).toStrictEqual([
			{ ...ticket, resolved_at: expect.any(Date), resolution: "requeued" },
		]);
		expect(await countRows(pool)).toStrictEqual({ forms: 1, jobs: 3, tickets: 1 });
		expect(await storedPayload(formId)).toStrictEqual(driftPayload);
	});

	it("retries geocoder and email failures without repeating completed stages", async () => {
		providers.geocode.mockResolvedValueOnce({ statusCode: 500 });
		providers.send.mockResolvedValueOnce({ statusCode: 500 });
		const formId = await ingestAndGetId(pool, payloadWith());

		const worker = await startPipelineWorker(pool, cleanup, providers);
		const { status, jobs } = await waitForState(formId, (state) => allJobsDone(state, 3));
		await worker.stop();

		expect(status).toBe("transformed");
		expect(Object.fromEntries(jobs.map(({ type, attempts }) => [type, attempts]))).toStrictEqual({
			process_form: 2,
			send_email: 2,
			deliver_formbot: 1,
		});
		expect(providers.geocode).toHaveBeenCalledTimes(2);
		expect(providers.send).toHaveBeenCalledTimes(2);
		expect(providers.deliver).toHaveBeenCalledTimes(1);
		expect(await transformedRowCount()).toBe(1);
		expect(await countRows(pool)).toStrictEqual({ forms: 1, jobs: 3, tickets: 0 });
	});
});
