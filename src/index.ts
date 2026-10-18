import { databaseUrl } from "./db/config";
import { createPool } from "./db/pool";
import { errorMessage } from "./helpers";
import { run } from "./run";

const PORT = process.env.PORT || 3000;

try {
	const connectionString = databaseUrl();

	run({
		pool: createPool(connectionString),
		connectionString,
		port: PORT,
		exit: (code) => process.exit(code),
		signals: process,
	});
} catch (error) {
	console.error(`Startup failed: ${errorMessage(error)}`);
	process.exit(1);
}
