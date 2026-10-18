import type { EventEmitter } from "node:events";

import { errorMessage } from "./helpers";
import { startService } from "./server";
import type { Service, ServiceOptions } from "./types";

type RunOptions = ServiceOptions & {
	exit: (code: number) => void;
	signals: EventEmitter;
	start?: (options: ServiceOptions) => Service;
};

const SIGNALS = ["SIGINT", "SIGTERM"];

export function run({ exit, signals, start = startService, ...options }: RunOptions): void {
	let exitCode = 0;
	let signalCount = 0;
	let shuttingDown: Promise<void> | undefined;
	let service: Service | undefined;

	const reportCleanupFailure = (error: unknown): void => {
		const errors = error instanceof AggregateError ? error.errors : [error];

		for (const cause of errors) {
			console.error("Shutdown cleanup failed:", errorMessage(cause));
		}

		exitCode = 1;
	};

	const attempt = async (step: () => Promise<unknown>): Promise<void> => {
		try {
			await step();
		} catch (error) {
			reportCleanupFailure(error);
		}
	};

	const cleanup = async (): Promise<void> => {
		await attempt(async () => service?.stop());
		await attempt(() => options.pool.end());

		for (const signal of SIGNALS) {
			signals.off(signal, onSignal);
		}

		exit(exitCode);
	};

	const shutdown = (code: number): void => {
		exitCode = Math.max(exitCode, code);
		shuttingDown ??= cleanup();
	};

	const fail = (message: string): void => {
		console.error(message);
		shutdown(1);
	};

	const onSignal = (): void => {
		signalCount += 1;

		if (signalCount > 1) {
			console.error("Forced exit");
			exit(1);
			return;
		}

		console.log("Shutting down; send the signal again to force exit");
		shutdown(0);
	};

	const onWorkerStopped = (): void => {
		if (!shuttingDown) {
			fail("Worker stopped unexpectedly");
		}
	};

	for (const signal of SIGNALS) {
		signals.on(signal, onSignal);
	}

	try {
		service = start(options);
	} catch (error) {
		fail(`Startup failed: ${errorMessage(error)}`);
		return;
	}

	service.ready.catch((error: unknown) => fail(`Startup failed: ${errorMessage(error)}`));
	service.workerStopped.then(onWorkerStopped, onWorkerStopped);
}
