import { Pool, type PoolClient } from "pg";

import { databaseUrl } from "./config";

export function createPool(connectionString: string = databaseUrl()): Pool {
	const pool = new Pool({ connectionString });

	pool.on("error", (error) => {
		console.error("Idle database client error:", error.message);
	});

	return pool;
}

export async function withTransaction<T>(
	pool: Pool,
	run: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await pool.connect();
	let releaseError: Error | undefined;

	try {
		await client.query("BEGIN");
		const result = await run(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK").catch((rollbackError: Error) => {
			releaseError = rollbackError;
		});
		throw error;
	} finally {
		client.release(releaseError);
	}
}
