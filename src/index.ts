import { databaseUrl } from "./db/config";
import { createPool } from "./db/pool";
import { errorMessage } from "./helpers";
import { startService } from "./server";

const PORT = process.env.PORT || 3000;

try {
	const connectionString = databaseUrl();
	const service = startService({
		pool: createPool(connectionString),
		connectionString,
		port: PORT,
	});

	process.on("SIGTERM", service.shutdown);
	process.on("SIGINT", service.shutdown);

	void service.shutdownComplete.then((code) => {
		process.exitCode = code;
	});
} catch (error) {
	console.error("Startup failed:", errorMessage(error));
	process.exitCode = 1;
}
