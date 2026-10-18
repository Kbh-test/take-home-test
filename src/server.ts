import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { createApp } from "./app";
import { deliverToFormBot } from "./jobs/deliver_formbot";
import { processForm } from "./jobs/process_form";
import { sendFormEmail } from "./jobs/send_email";
import type { Service, ServiceOptions } from "./types";
import type { Worker } from "./worker/types";
import { startWorker } from "./worker/worker";

const handlers = {
	process_form: processForm,
	send_email: sendFormEmail,
	deliver_formbot: deliverToFormBot,
};

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

export function startService({ pool, connectionString, port, maxAttempts }: ServiceOptions): Service {
	let stopRequested = false;
	let worker: Worker | null = null;
	let stopping: Promise<void> | undefined;
	let followWorker!: (stopped: Promise<void>) => void;

	const workerStopped = new Promise<void>((resolve) => {
		followWorker = resolve;
	});

	const server = createServer(createApp(pool));
	const listening = once(server, "listening");
	server.listen(port);

	const ready = listening.then(async () => {
		console.log(`Server is running on http://localhost:${port}`);

		if (stopRequested) {
			return;
		}

		worker = await startWorker({ pool, connectionString, handlers, maxAttempts });

		if (worker) {
			followWorker(worker.stopped.catch(() => undefined));
		}
	});

	const stopWorker = () => worker?.stop();

	const shutdown = async (): Promise<void> => {
		stopRequested = true;

		const results = await Promise.allSettled([
			listening.then(() => closeServer(server), () => undefined),
			ready.then(stopWorker, stopWorker),
		]);
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));

		if (errors.length > 0) {
			throw new AggregateError(errors, "Service stop failed");
		}
	};

	return {
		ready,
		stop: () => {
			stopping ??= shutdown();
			return stopping;
		},
		workerStopped,
	};
}
