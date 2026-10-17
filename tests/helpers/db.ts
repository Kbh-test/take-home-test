import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { databaseUrl } from "../../src/db/config";

const ADMIN_URL = databaseUrl();

export type TempDatabase = {
	url: string;
	drop: () => Promise<void>;
};

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
