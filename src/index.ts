import { createPool } from "./db/pool";
import { startService } from "./server";

const PORT = process.env.PORT || 3000;

try {
	const service = startService({ pool: createPool(), port: PORT });

	process.on("SIGTERM", service.shutdown);
	process.on("SIGINT", service.shutdown);

	void service.shutdownComplete.then((code) => {
		process.exitCode = code;
	});
} catch (error) {
	console.error(
		"Startup failed:",
		error instanceof Error ? error.message : error,
	);
	process.exitCode = 1;
}
