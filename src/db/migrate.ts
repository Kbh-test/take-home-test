import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

import { databaseUrl } from "./config";
import { MIGRATION_LOCK_ID } from "./locks";

export const MIGRATIONS_DIR = path.join(__dirname, "migrations");

const MIGRATION_FILENAME_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

async function listMigrationFiles(directory: string): Promise<string[]> {
	const files = (await readdir(directory)).filter((file) => file.endsWith(".sql"));
	const misnamed = files.filter((file) => !MIGRATION_FILENAME_PATTERN.test(file));

	if (misnamed.length > 0) {
		throw new Error(
			`Migration files must look like 001_name.sql: ${misnamed.join(", ")}`,
		);
	}

	return files.sort();
}

async function ensureHistoryTable(client: Client): Promise<void> {
	await client.query(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
	`);
}

async function findPendingMigrations(
	client: Client,
	filenames: string[],
): Promise<string[]> {
	const { rows } = await client.query<{ filename: string }>(
		"SELECT filename FROM schema_migrations",
	);
	const applied = new Set(rows.map((row) => row.filename));

	return filenames.filter((filename) => !applied.has(filename));
}

async function applyMigration(
	client: Client,
	directory: string,
	filename: string,
): Promise<void> {
	const sql = await readFile(path.join(directory, filename), "utf8");

	try {
		await client.query(sql);
	} catch (error) {
		throw new Error(`${filename}: ${(error as Error).message}`, {
			cause: error,
		});
	}

	await client.query(
		"INSERT INTO schema_migrations (filename) VALUES ($1)",
		[filename],
	);
}

export async function migrate(
	client: Client,
	directory: string = MIGRATIONS_DIR,
): Promise<string[]> {
	const filenames = await listMigrationFiles(directory);

	await client.query("BEGIN");

	try {
		await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
		await ensureHistoryTable(client);
		const pending = await findPendingMigrations(client, filenames);

		for (const filename of pending) {
			await applyMigration(client, directory, filename);
		}

		await client.query("COMMIT");
		return pending;
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	}
}

async function main(): Promise<void> {
	const client = new Client({ connectionString: databaseUrl() });

	try {
		await client.connect();

		const applied = await migrate(client);

		console.log(
			applied.length > 0
				? `Applied ${applied.join(", ")}`
				: "No pending migrations",
		);
	} finally {
		await client.end();
	}
}

if (require.main === module) {
	main().catch((error: unknown) => {
		console.error(
			"Migration failed:",
			error instanceof Error ? error.message : error,
		);
		process.exitCode = 1;
	});
}
