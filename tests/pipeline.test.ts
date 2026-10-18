import { setTimeout as sleep } from "node:timers/promises";
import type { Pool } from "pg";

import { ingestForm } from "../src/ingest/ingest";
import { deliverToFormBot } from "../src/jobs/deliver_formbot";
import { processForm } from "../src/jobs/process_form";
import { sendFormEmail } from "../src/jobs/send_email";
import type { deliverForm } from "../src/providers/formbot";
import type { lookupPostcode } from "../src/providers/idealpostcodes";
import type { sendEmail } from "../src/providers/sendgrid";
import type { FormStatus, JobStatus, JobType } from "../src/types";
import { startWorker } from "../src/worker/worker";
import { payloadWith, transformedWith } from "./fixtures/form";
import { countRows, createCleanup, createMigratedPool } from "./helpers/db";

type JobRow = { type: JobType; status: JobStatus; last_error: string | null };

const coordinates = { latitude: -5.05, longitude: 50.05 };

describe("pipeline", () => {
	const cleanup = createCleanup();
	let pool: Pool;

	beforeEach(async () => {
		pool = await createMigratedPool(cleanup);
	});

	afterEach(() => cleanup.run());

	const jobsOf = async (formId: string): Promise<JobRow[]> => {
		const { rows } = await pool.query<JobRow>(
			"SELECT type, status, last_error FROM jobs WHERE inbound_form_id = $1 ORDER BY id",
			[formId],
		);
		return rows;
	};

	const waitForJobsDone = async (formId: string): Promise<JobRow[]> => {
		let jobs: JobRow[] = [];

		for (let i = 0; i < 200; i++) {
			jobs = await jobsOf(formId);
			if (jobs.length === 3 && jobs.every((job) => job.status === "done")) {
				return jobs;
			}
			await sleep(25);
		}

		throw new Error(`Jobs did not finish: ${JSON.stringify(jobs)}`);
	};

	it("ingests a form, processes it and delivers it by email and to FORM-BOT", async () => {
		await ingestForm(pool, payloadWith());
		const { rows } = await pool.query<{ id: string }>("SELECT id FROM inbound_forms");
		const formId = rows[0].id;

		const geocode: jest.MockedFunction<typeof lookupPostcode> = jest
			.fn()
			.mockResolvedValue({ statusCode: 200, body: coordinates });
		const send: jest.MockedFunction<typeof sendEmail> = jest
			.fn()
			.mockResolvedValue({ statusCode: 202, body: undefined });
		const deliver: jest.MockedFunction<typeof deliverForm> = jest
			.fn()
			.mockResolvedValue({ statusCode: 200, body: undefined });

		const worker = await startWorker({
			pool,
			connectionString: pool.options.connectionString!,
			handlers: {
				process_form: (p, id) => processForm(p, id, geocode),
				send_email: (p, id) => sendFormEmail(p, id, send),
				deliver_formbot: (p, id) => deliverToFormBot(p, id, deliver),
			},
			pollIntervalMs: 10,
		});
		expect(worker).not.toBeNull();
		cleanup.track(worker!, (w) => w.stop());

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
