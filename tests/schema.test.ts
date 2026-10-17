import { randomUUID } from "node:crypto";
import type { Client } from "pg";

import { migrate } from "../src/db/migrate";
import { connect, createCleanup, createTempDatabase } from "./helpers/db";

describe("initial schema", () => {
	const cleanup = createCleanup();
	let client: Client;

	beforeAll(async () => {
		const db = cleanup.track(await createTempDatabase(), (d) => d.drop());
		client = cleanup.track(await connect(db.url), (c) => c.end());
		await migrate(client);
	});

	afterAll(() => cleanup.run());

	const insertForm = async (
		payload: object | string = { id: randomUUID() },
		status = "received",
	): Promise<string> => {
		const { rows } = await client.query<{ id: string }>(
			"INSERT INTO inbound_forms (payload, status) VALUES ($1, $2) RETURNING id",
			[payload, status],
		);

		return rows[0].id;
	};

	const insertJob = async (formId: string): Promise<string> => {
		const { rows } = await client.query<{ id: string }>(
			"INSERT INTO jobs (inbound_form_id, type) VALUES ($1, 'send_email') RETURNING id",
			[formId],
		);

		return rows[0].id;
	};

	const insertTicket = async (
		formId: string,
		jobId: string | null = null,
	): Promise<string> => {
		const { rows } = await client.query<{ id: string }>(
			"INSERT INTO dead_letters (inbound_form_id, job_id, reason) VALUES ($1, $2, 'test') RETURNING id",
			[formId, jobId],
		);

		return rows[0].id;
	};

	it("treats payloads that differ only in key order and whitespace as duplicates", async () => {
		const ref = randomUUID();

		await insertForm(`{"ref": "${ref}", "n": 1}`);
		await expect(insertForm(`{  "n":1,"ref":"${ref}"  }`)).rejects.toThrow(
			"inbound_forms_payload_hash_key",
		);
	});

	it("rejects an unknown form status", async () => {
		await expect(insertForm(undefined, "processing")).rejects.toThrow(
			"inbound_forms_status_check",
		);
	});

	it("refuses to queue the same job type twice for a form", async () => {
		const formId = await insertForm();

		await insertJob(formId);
		await expect(insertJob(formId)).rejects.toThrow(
			"jobs_inbound_form_id_type_key",
		);
	});

	it("rejects an unknown job status", async () => {
		const formId = await insertForm();

		await expect(
			client.query(
				"INSERT INTO jobs (inbound_form_id, type, status) VALUES ($1, 'send_email', 'failed')",
				[formId],
			),
		).rejects.toThrow("jobs_status_check");
	});

	it("rejects impossible counter values", async () => {
		await expect(
			client.query(
				"INSERT INTO inbound_forms (payload, status, received_count) VALUES ($1, 'received', 0)",
				[{ id: randomUUID() }],
			),
		).rejects.toThrow("inbound_forms_received_count_check");

		await expect(
			client.query(
				"INSERT INTO jobs (inbound_form_id, type, attempts) VALUES ($1, 'send_email', -1)",
				[await insertForm()],
			),
		).rejects.toThrow("jobs_attempts_check");
	});

	it("links a job ticket only to a job of the same form", async () => {
		const formId = await insertForm();
		const jobId = await insertJob(formId);

		await insertTicket(formId, jobId);
		await expect(insertTicket(await insertForm(), jobId)).rejects.toThrow(
			"dead_letters_job_belongs_to_form_fkey",
		);
	});

	it("allows only one transformed row per application reference", async () => {
		const ref = randomUUID();
		const insertTransformed = (formId: string) =>
			client.query(
				`INSERT INTO transformed_forms (
					inbound_form_id, application_reference, session_id, first_name, last_name,
					email, gender, date_of_birth, mobile_number, address_line_1, address_line_2,
					postcode, country, latitude, longitude
				) VALUES ($1, $2, 's', 'Ada', 'Lovelace', 'a@b.c', 'female', '1990-01-31',
					'07000', 'l1', 'l2', 'AB1 2CD', 'UK', -5.05, 50.05)`,
				[formId, ref],
			);

		await insertTransformed(await insertForm());

		await expect(insertTransformed(await insertForm())).rejects.toThrow(
			"transformed_forms_application_reference_key",
		);
	});

	it("refuses to close a ticket without a note", async () => {
		const ticketId = await insertTicket(await insertForm());

		for (const note of [null, "   "]) {
			await expect(
				client.query(
					`UPDATE dead_letters
					SET resolved_at = now(), resolved_by = 'cli', resolution = 'closed', resolution_note = $2
					WHERE id = $1`,
					[ticketId, note],
				),
			).rejects.toThrow("dead_letters_close_needs_note");
		}
	});

	it("refuses a half-resolved ticket", async () => {
		const ticketId = await insertTicket(await insertForm());

		await expect(
			client.query(
				"UPDATE dead_letters SET resolved_at = now() WHERE id = $1",
				[ticketId],
			),
		).rejects.toThrow("dead_letters_resolution_complete");
	});

	it("allows requeueing a ticket without a note", async () => {
		const ticketId = await insertTicket(await insertForm());

		await expect(
			client.query(
				`UPDATE dead_letters
				SET resolved_at = now(), resolved_by = 'cli', resolution = 'requeued'
				WHERE id = $1`,
				[ticketId],
			),
		).resolves.toMatchObject({ rowCount: 1 });
	});
});
