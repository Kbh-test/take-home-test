import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "pg";

import { MIGRATIONS_DIR, migrate } from "../src/db/migrate";
import { connect, createCleanup, createTempDatabase } from "./helpers/db";

const tableExists = async (client: Client, table: string): Promise<boolean> => {
	const { rows } = await client.query<{ exists: boolean }>(
		"SELECT to_regclass($1) IS NOT NULL AS exists",
		[table],
	);

	return rows[0].exists;
};

const appliedFilenames = async (client: Client): Promise<string[]> => {
	const { rows } = await client.query<{ filename: string }>(
		"SELECT filename FROM schema_migrations ORDER BY filename",
	);

	return rows.map((row) => row.filename);
};

const ALL_MIGRATIONS = ["001_initial_schema.sql", "002_ticket_reason_code.sql"];

describe("migrate", () => {
	const cleanup = createCleanup();
	let dbUrl: string;
	let client: Client;
	let dir: string;

	const writeMigration = (file: string, sql: string) =>
		writeFile(path.join(dir, file), sql);

	const copyMigration = (file: string) =>
		copyFile(path.join(MIGRATIONS_DIR, file), path.join(dir, file));

	const insertLegacyTicket = async (
		reason: string,
		jobType: string | null = null,
	): Promise<string> => {
		const form = await client.query<{ id: string }>(
			"INSERT INTO inbound_forms (payload, status) VALUES ($1, 'blocked') RETURNING id",
			[{ id: randomUUID() }],
		);
		const formId = form.rows[0].id;
		const job = jobType
			? await client.query<{ id: string }>(
					"INSERT INTO jobs (inbound_form_id, type, status) VALUES ($1, $2, 'dead') RETURNING id",
					[formId, jobType],
				)
			: null;
		const ticket = await client.query<{ id: string }>(
			"INSERT INTO dead_letters (inbound_form_id, job_id, reason) VALUES ($1, $2, $3) RETURNING id",
			[formId, job?.rows[0].id ?? null, reason],
		);

		return ticket.rows[0].id;
	};

	beforeEach(async () => {
		dbUrl = cleanup.track(await createTempDatabase(), (db) => db.drop()).url;
		client = cleanup.track(await connect(dbUrl), (c) => c.end());
		dir = cleanup.track(
			await mkdtemp(path.join(tmpdir(), "migrations-")),
			(d) => rm(d, { recursive: true, force: true }),
		);
	});

	afterEach(() => cleanup.run());

	it("applies every migration on a fresh database", async () => {
		const applied = await migrate(client);

		expect(applied).toEqual(ALL_MIGRATIONS);
		expect(await appliedFilenames(client)).toEqual(ALL_MIGRATIONS);

		for (const table of [
			"inbound_forms",
			"transformed_forms",
			"jobs",
			"dead_letters",
		]) {
			expect(await tableExists(client, table)).toBe(true);
		}
	});

	it("does nothing on a second run", async () => {
		await migrate(client);

		expect(await migrate(client)).toEqual([]);
		expect(await appliedFilenames(client)).toEqual(ALL_MIGRATIONS);
	});

	it("applies files in filename order", async () => {
		await writeMigration("002_add_column.sql", "ALTER TABLE a ADD COLUMN b int;");
		await writeMigration("001_create_table.sql", "CREATE TABLE a (id int);");

		expect(await migrate(client, dir)).toEqual([
			"001_create_table.sql",
			"002_add_column.sql",
		]);
	});

	it("rolls back the whole run when a migration fails", async () => {
		await writeMigration("001_ok.sql", "CREATE TABLE a (id int);");
		await writeMigration(
			"002_bad.sql",
			"CREATE TABLE b (id int); SELECT 1 / 0;",
		);

		await expect(migrate(client, dir)).rejects.toThrow(
			"002_bad.sql: division by zero",
		);

		expect(await tableExists(client, "a")).toBe(false);
		expect(await tableExists(client, "b")).toBe(false);
		expect(await tableExists(client, "schema_migrations")).toBe(false);
	});

	it("keeps earlier committed migrations when a later run fails", async () => {
		await writeMigration("001_ok.sql", "CREATE TABLE a (id int);");
		await migrate(client, dir);

		await writeMigration(
			"002_bad.sql",
			"CREATE TABLE b (id int); SELECT 1 / 0;",
		);

		await expect(migrate(client, dir)).rejects.toThrow("002_bad.sql");
		expect(await tableExists(client, "a")).toBe(true);
		expect(await tableExists(client, "b")).toBe(false);
		expect(await appliedFilenames(client)).toEqual(["001_ok.sql"]);
	});

	it("fails visibly when a table already exists", async () => {
		await client.query("CREATE TABLE inbound_forms (id int)");

		await expect(migrate(client)).rejects.toThrow(
			'001_initial_schema.sql: relation "inbound_forms" already exists',
		);
	});

	it("applies each migration once when two runs race", async () => {
		const other = await connect(dbUrl);

		try {
			const results = await Promise.all([migrate(client), migrate(other)]);

			expect(results.flat()).toEqual(ALL_MIGRATIONS);
			expect(await appliedFilenames(client)).toEqual(ALL_MIGRATIONS);
		} finally {
			await other.end();
		}
	});

	it("backfills reason codes for legacy tickets", async () => {
		await copyMigration("001_initial_schema.sql");
		await migrate(client, dir);

		const missing = await insertLegacyTicket("Missing application_reference");
		const conflict = await insertLegacyTicket(
			`application_reference already accepted on form ${randomUUID()}`,
		);
		const validation = await insertLegacyTicket(
			"Validation failed: name must have at least two words",
		);
		const email = await insertLegacyTicket(
			"send_email failed: Provider returned 500",
			"send_email",
		);
		const delivery = await insertLegacyTicket(
			"deliver_formbot failed: Provider returned 500",
			"deliver_formbot",
		);

		await copyMigration("002_ticket_reason_code.sql");

		expect(await migrate(client, dir)).toEqual(["002_ticket_reason_code.sql"]);
		expect(
			(await client.query("SELECT id, reason_code FROM dead_letters ORDER BY id")).rows,
		).toEqual([
			{ id: missing, reason_code: "missing_reference" },
			{ id: conflict, reason_code: "reference_conflict" },
			{ id: validation, reason_code: "validation_failed" },
			{ id: email, reason_code: "job_failed" },
			{ id: delivery, reason_code: "delivery_uncertain" },
		]);
	});

	it("rolls back the reason code migration when a legacy form ticket is unrecognised", async () => {
		await copyMigration("001_initial_schema.sql");
		await migrate(client, dir);
		await insertLegacyTicket("Something unexpected");
		const snapshot = async () => ({
			forms: (await client.query("SELECT * FROM inbound_forms ORDER BY id")).rows,
			tickets: (await client.query("SELECT * FROM dead_letters ORDER BY id")).rows,
		});
		const before = await snapshot();

		await copyMigration("002_ticket_reason_code.sql");

		await expect(migrate(client, dir)).rejects.toThrow(
			'002_ticket_reason_code.sql: column "reason_code" of relation "dead_letters" contains null values',
		);
		expect(await appliedFilenames(client)).toEqual(["001_initial_schema.sql"]);
		expect(await snapshot()).toEqual(before);

		const schema = await client.query(
			`SELECT
				EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_name = 'dead_letters' AND column_name = 'reason_code'
				) AS has_column,
				EXISTS (
					SELECT 1 FROM pg_constraint WHERE conname = 'dead_letters_reason_code_check'
				) AS has_constraint`,
		);
		expect(schema.rows).toEqual([{ has_column: false, has_constraint: false }]);
	});

	it("refuses misnamed migration files", async () => {
		await writeMigration("1_create_table.sql", "CREATE TABLE a (id int);");

		await expect(migrate(client, dir)).rejects.toThrow(
			"Migration files must look like 001_name.sql: 1_create_table.sql",
		);
		expect(await tableExists(client, "schema_migrations")).toBe(false);
	});
});
