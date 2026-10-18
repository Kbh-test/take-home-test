import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";

import { databaseUrl } from "../../src/db/config";
import { migrate } from "../../src/db/migrate";
import { createPool } from "../../src/db/pool";
import { ingestForm } from "../../src/ingest/ingest";

const ADMIN_URL = databaseUrl();

export type TempDatabase = {
	url: string;
	drop: () => Promise<void>;
};

export type Cleanup = ReturnType<typeof createCleanup>;

export function createCleanup() {
	const steps: Array<() => Promise<unknown>> = [];

	return {
		track: <T>(resource: T, release: (resource: T) => Promise<unknown>): T => {
			steps.unshift(() => release(resource));
			return resource;
		},
		run: async () => {
			const errors: unknown[] = [];

			for (const step of steps.splice(0)) {
				await step().catch((error: unknown) => errors.push(error));
			}

			if (errors.length > 0) {
				throw new AggregateError(errors, "Test cleanup failed");
			}
		},
	};
}

export async function connect(url: string): Promise<Client> {
	const client = new Client({ connectionString: url });

	try {
		await client.connect();
	} catch (error) {
		await client.end().catch(() => undefined);
		throw error;
	}

	return client;
}

async function admin<T>(run: (client: Client) => Promise<T>): Promise<T> {
	const client = await connect(ADMIN_URL);

	try {
		return await run(client);
	} finally {
		await client.end();
	}
}

export async function createTempDatabase(): Promise<TempDatabase> {
	const name = `test_${randomUUID().replaceAll("-", "")}`;
	const url = new URL(ADMIN_URL);

	url.pathname = `/${name}`;

	await admin((client) => client.query(`CREATE DATABASE ${name}`));

	return {
		url: url.toString(),
		drop: async () => {
			await admin((client) =>
				client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
			);
		},
	};
}

export async function createMigratedPool(cleanup: Cleanup): Promise<Pool> {
	const db = cleanup.track(await createTempDatabase(), (d) => d.drop());
	const client = await connect(db.url);

	try {
		await migrate(client);
	} finally {
		await client.end();
	}

	return cleanup.track(createPool(db.url), (pool) => pool.end());
}

export type RowCounts = { forms: number; jobs: number; tickets: number };

export async function countRows(pool: Pool): Promise<RowCounts> {
	const { rows } = await pool.query<RowCounts>(`
		SELECT
			(SELECT count(*)::int FROM inbound_forms) AS forms,
			(SELECT count(*)::int FROM jobs) AS jobs,
			(SELECT count(*)::int FROM dead_letters) AS tickets
	`);

	return rows[0];
}

export async function ingestAndGetId(pool: Pool, payload: unknown): Promise<string> {
	await ingestForm(pool, payload);
	const { rows } = await pool.query<{ id: string }>(
		"SELECT id FROM inbound_forms WHERE payload_hash = payload_sha256($1::jsonb)",
		[JSON.stringify(payload)],
	);

	if (rows.length === 0) {
		throw new Error("Fixture setup failed: ingested form not found by payload hash");
	}

	return rows[0].id;
}

export async function jobsOf(pool: Pool, formId: string) {
	const { rows } = await pool.query(
		"SELECT * FROM jobs WHERE inbound_form_id = $1 ORDER BY id",
		[formId],
	);
	return rows;
}

export async function snapshot(pool: Pool) {
	const forms = await pool.query("SELECT * FROM inbound_forms ORDER BY id");
	const jobs = await pool.query("SELECT * FROM jobs ORDER BY id");
	const tickets = await pool.query("SELECT * FROM dead_letters ORDER BY id");
	const transformed = await pool.query("SELECT * FROM transformed_forms ORDER BY inbound_form_id");

	return { forms: forms.rows, jobs: jobs.rows, tickets: tickets.rows, transformed: transformed.rows };
}
