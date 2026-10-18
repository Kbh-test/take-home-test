import type { Express } from "express";
import type { Pool } from "pg";
import request from "supertest";

import { createApp } from "../src/app";
import { payloadWith } from "./fixtures/form";
import { countRows, createCleanup, createMigratedPool } from "./helpers/db";

type StoredForm = {
	id: string;
	application_reference: string | null;
	payload: unknown;
	status: string;
	received_count: number;
};

const { application_reference: _, ...withoutReference } = payloadWith();

describe("POST /ingest storage", () => {
	const cleanup = createCleanup();
	let pool: Pool;
	let app: Express;

	beforeEach(async () => {
		pool = await createMigratedPool(cleanup);
		app = createApp(pool);
	});

	afterEach(async () => {
		jest.restoreAllMocks();
		await cleanup.run();
	});

	const post = (payload: unknown) =>
		request(app)
			.post("/ingest")
			.set("Content-Type", "application/json")
			.send(JSON.stringify(payload));

	const storedForms = async (): Promise<StoredForm[]> => {
		const { rows } = await pool.query<StoredForm>(
			`SELECT id, application_reference, payload, status, received_count
			FROM inbound_forms ORDER BY first_received_at, status DESC`,
		);
		return rows;
	};

	const jobsAndTickets = async () => {
		const jobs = await pool.query(
			"SELECT inbound_form_id, type, status FROM jobs",
		);
		const tickets = await pool.query(
			"SELECT inbound_form_id, job_id, reason FROM dead_letters",
		);
		return { jobs: jobs.rows, tickets: tickets.rows };
	};

	const failInsertsInto = (table: "jobs" | "dead_letters") =>
		pool.query(`
			CREATE FUNCTION fail_insert() RETURNS trigger LANGUAGE plpgsql
				AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
			CREATE TRIGGER fail_insert BEFORE INSERT ON ${table}
				FOR EACH ROW EXECUTE FUNCTION fail_insert();
		`);

	it("stores a new submission unchanged and queues one process_form job", async () => {
		const response = await post(payloadWith()).expect(202);

		expect(response.body).toEqual({ status: "accepted" });

		const [form] = await storedForms();
		expect(form).toMatchObject({
			application_reference: "GRU-123089-2026",
			payload: payloadWith(),
			status: "received",
			received_count: 1,
		});
		expect(await jobsAndTickets()).toEqual({
			jobs: [{ inbound_form_id: form.id, type: "process_form", status: "pending" }],
			tickets: [],
		});
	});

	it("collapses repeats, including reordered keys, into one form and one job", async () => {
		const reordered = Object.fromEntries(Object.entries(payloadWith()).reverse());

		await post(payloadWith()).expect(202);
		await post(payloadWith()).expect(202);
		await post(reordered).expect(202);

		expect(await countRows(pool)).toEqual({ forms: 1, jobs: 1, tickets: 0 });
		expect((await storedForms())[0].received_count).toBe(3);
	});

	it("keeps both versions when a reference arrives with different content", async () => {
		const original = payloadWith();
		const changed = payloadWith({ email: "changed@example.com" });

		await post(original).expect(202);
		await post(changed).expect(202);
		await post(changed).expect(202);

		const [accepted, blocked] = await storedForms();
		expect(accepted).toMatchObject({ payload: original, status: "received" });
		expect(blocked).toMatchObject({ payload: changed, status: "blocked", received_count: 2 });
		expect(await jobsAndTickets()).toEqual({
			jobs: [{ inbound_form_id: accepted.id, type: "process_form", status: "pending" }],
			tickets: [
				{
					inbound_form_id: blocked.id,
					job_id: null,
					reason: `application_reference already accepted on form ${accepted.id}`,
				},
			],
		});
	});

	it("blocks a missing reference with one ticket, however often it repeats", async () => {
		await post(withoutReference).expect(202);
		await post(withoutReference).expect(202);

		const [form] = await storedForms();
		expect(form).toMatchObject({
			application_reference: null,
			payload: withoutReference,
			status: "blocked",
			received_count: 2,
		});
		expect(await jobsAndTickets()).toEqual({
			jobs: [],
			tickets: [
				{ inbound_form_id: form.id, job_id: null, reason: "Missing application_reference" },
			],
		});
	});

	it("stores a JSON null as blocked with a ticket", async () => {
		await post(null).expect(202);

		expect((await storedForms())[0]).toMatchObject({ payload: null, status: "blocked" });
		expect(await countRows(pool)).toEqual({ forms: 1, jobs: 0, tickets: 1 });
	});

	it("stores a JSON string as blocked with a ticket", async () => {
		await post("schema drift").expect(202);

		expect((await storedForms())[0]).toMatchObject({ payload: "schema drift", status: "blocked" });
		expect(await countRows(pool)).toEqual({ forms: 1, jobs: 0, tickets: 1 });
	});

	it("stores an explicitly submitted {} as blocked with a ticket", async () => {
		await post({}).expect(202);

		expect((await storedForms())[0]).toMatchObject({ payload: {}, status: "blocked" });
		expect(await countRows(pool)).toEqual({ forms: 1, jobs: 0, tickets: 1 });
	});

	it("preserves unexpected fields and wrong types without rejecting them", async () => {
		const body = payloadWith({ email: 42, surprise: { nested: [1, "two", null] } });

		await post(body).expect(202);

		const [form] = await storedForms();
		expect(form).toMatchObject({ payload: body, status: "received" });
		expect(await countRows(pool)).toEqual({ forms: 1, jobs: 1, tickets: 0 });
	});

	it("stores concurrent duplicates once with one job", async () => {
		await Promise.all(
			Array.from({ length: 20 }, () => post(payloadWith()).expect(202)),
		);

		expect(await countRows(pool)).toEqual({ forms: 1, jobs: 1, tickets: 0 });
		expect((await storedForms())[0].received_count).toBe(20);
	});

	it("accepts exactly one of several concurrent versions of a reference", async () => {
		await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				post(payloadWith({ email: `v${i}@example.com` })).expect(202),
			),
		);

		expect(await countRows(pool)).toEqual({ forms: 10, jobs: 1, tickets: 9 });

		const statuses = (await storedForms()).map((form) => form.status);
		expect(statuses.filter((status) => status === "received")).toHaveLength(1);
	});

	it("replies 503 and writes nothing when queueing the job fails", async () => {
		jest.spyOn(console, "error").mockImplementation(() => undefined);
		await failInsertsInto("jobs");

		const response = await post(payloadWith()).expect(503);

		expect(response.body).toEqual({ error: "Service unavailable, retry later" });
		expect(await countRows(pool)).toEqual({ forms: 0, jobs: 0, tickets: 0 });
	});

	it("replies 503 and writes nothing when opening a ticket fails", async () => {
		jest.spyOn(console, "error").mockImplementation(() => undefined);
		await failInsertsInto("dead_letters");

		const response = await post(withoutReference).expect(503);

		expect(response.body).toEqual({ error: "Service unavailable, retry later" });
		expect(await countRows(pool)).toEqual({ forms: 0, jobs: 0, tickets: 0 });
	});
});
