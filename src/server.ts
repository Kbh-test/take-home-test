import { createServer, type Server } from "node:http";
import type { Pool } from "pg";

import { createApp } from "./app";
import { errorMessage } from "./helpers";
import { deliverToFormBot } from "./jobs/deliver_formbot";
import { processForm } from "./jobs/process_form";
import { sendFormEmail } from "./jobs/send_email";
import type { Worker } from "./worker/types";
import { startWorker } from "./worker/worker";

const handlers = {
	process_form: processForm,
	send_email: sendFormEmail,
	deliver_formbot: deliverToFormBot,
};

function listenHttpServer(server: Server, port: number | string): Promise<Server> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, () => {
			server.off("error", reject);
			resolve(server);
		});
	});
}

function closeHttpServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

export function startService({
	pool,
	connectionString,
	port,
}: {
	pool: Pool;
	connectionString: string;
	port: number | string;
}) {
	let stopping = false;
	let failed = false;
	let worker: Worker | null = null;
	let requestShutdown!: () => void;

	const shutdownRequested = new Promise<void>((resolve) => {
		requestShutdown = resolve;
	});

	const shutdown = (): Promise<number> => {
		stopping = true;
		requestShutdown();
		return shutdownComplete;
	};

	const fail = (message: string): void => {
		console.error(message);
		failed = true;
		void shutdown();
	};

	const onWorkerStopped = (message: string): void => {
		if (!stopping) {
			fail(message);
		}
	};

	const listening = listenHttpServer(createServer(createApp(pool)), port);

	const startupComplete = listening.then(async () => {
		console.log(`Server is running on http://localhost:${port}`);

		if (stopping) {
			return;
		}

		worker = await startWorker({ pool, connectionString, handlers });
		worker?.stopped.then(
			() => onWorkerStopped("Worker stopped unexpectedly"),
			(error: unknown) => onWorkerStopped(`Worker stopped unexpectedly: ${errorMessage(error)}`),
		);
	});

	startupComplete.catch((error: unknown) => fail(`Startup failed: ${errorMessage(error)}`));

	const stopWorker = () => worker?.stop();

	const cleanup = async (): Promise<number> => {
		const httpAndWorker = await Promise.allSettled([
			listening.then(closeHttpServer, () => undefined),
			startupComplete.then(stopWorker, stopWorker),
		]);
		const poolEnded = await Promise.allSettled([pool.end()]);

		const errors = [...httpAndWorker, ...poolEnded].flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);

		for (const error of errors) {
			console.error("Shutdown cleanup failed:", errorMessage(error));
		}

		return failed || errors.length > 0 ? 1 : 0;
	};

	const shutdownComplete = shutdownRequested.then(cleanup);

	return { shutdown, shutdownComplete };
}
