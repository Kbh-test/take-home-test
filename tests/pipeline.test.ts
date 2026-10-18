import type { Pool } from "pg";

import type { FormStatus, JobStatus, JobType } from "../src/types";
import { coordinates, payloadWith, transformedWith } from "./fixtures/form";
import { countRows, createCleanup, createMigratedPool, ingestAndGetId, jobsOf } from "./helpers/db";
import { waitUntil } from "./helpers/wait";
import { fakeProviders, startPipelineWorker } from "./helpers/worker";

type JobRow = { type: JobType; status: JobStatus; last_error: string | null };

describe("pipeline", () => {
	const cleanup = createCleanup();
	let pool: Pool;

	beforeEach(async () => {
		pool = await createMigratedPool(cleanup);
	});

	afterEach(() => cleanup.run());

	const waitForJobsDone = (formId: string): Promise<JobRow[]> =>
		waitUntil(
			() => jobsOf(pool, formId),
			(jobs) => jobs.length === 3 && jobs.every((job) => job.status === "done"),
			`Jobs of form ${formId}`,
			{ intervalMs: 25, maxAttempts: 200 },
		);

	it("ingests a form, processes it and delivers it by email and to FORM-BOT", async () => {
		const formId = await ingestAndGetId(pool, payloadWith());

		const providers = fakeProviders();
		const { geocode, send, deliver } = providers;
		await startPipelineWorker(pool, cleanup, providers);

		const jobs = await waitForJobsDone(formId);
		const { rows: forms } = await pool.query<{ status: FormStatus }>(
			"SELECT status FROM inbound_forms WHERE id = $1",
			[formId],
		);

		expect(jobs.map(({ type, status }) => ({ type, status }))).toStrictEqual([
			{ type: "process_form", status: "done" },
			{ type: "send_email", status: "done" },
			{ type: "deliver_formbot", status: "done" },
		]);
		expect(forms[0].status).toBe("transformed");
		expect(geocode).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "happyforms@bots.com" }), expect.any(AbortSignal));
		expect(deliver.mock.calls).toStrictEqual([
			[{ idempotencyKey: formId, form: { ...transformedWith(), ...coordinates } }, expect.any(AbortSignal)],
		]);
		expect((await countRows(pool)).tickets).toBe(0);
	});
});
