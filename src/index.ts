import { databaseUrl } from "./db/config";
import { createPool } from "./db/pool";
import { errorMessage, readAttemptLimit, readPort } from "./helpers";
import { run } from "./run";

try {
	const port = readPort(process.env.PORT);
	const maxAttempts = {
		process_form: readAttemptLimit("PROCESS_FORM_MAX_ATTEMPTS", process.env.PROCESS_FORM_MAX_ATTEMPTS),
		send_email: readAttemptLimit("SEND_EMAIL_MAX_ATTEMPTS", process.env.SEND_EMAIL_MAX_ATTEMPTS),
	};
	const connectionString = databaseUrl();

	run({
		pool: createPool(connectionString),
		connectionString,
		port,
		maxAttempts,
		exit: (code) => process.exit(code),
		signals: process,
	});
} catch (error) {
	console.error(`Startup failed: ${errorMessage(error)}`);
	process.exit(1);
}
