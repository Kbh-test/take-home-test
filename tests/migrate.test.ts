import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "pg";

import { migrate } from "../src/db/migrate";
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

describe("migrate", () => {
	const cleanup = createCleanup();
	let dbUrl: string;
	let client: Client;
	let dir: string;

	const writeMigration = (file: string, sql: string) =>
		writeFile(path.join(dir, file), sql);

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

		expect(applied).toEqual(["001_initial_schema.sql"]);
		expect(await appliedFilenames(client)).toEqual(["001_initial_schema.sql"]);

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
		expect(await appliedFilenames(client)).toEqual(["001_initial_schema.sql"]);
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

			expect(results.flat()).toEqual(["001_initial_schema.sql"]);
			expect(await appliedFilenames(client)).toEqual([
				"001_initial_schema.sql",
			]);
		} finally {
			await other.end();
		}
	});

	it("refuses misnamed migration files", async () => {
		await writeMigration("1_create_table.sql", "CREATE TABLE a (id int);");

		await expect(migrate(client, dir)).rejects.toThrow(
			"Migration files must look like 001_name.sql: 1_create_table.sql",
		);
		expect(await tableExists(client, "schema_migrations")).toBe(false);
	});
});
