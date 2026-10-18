import { setTimeout as sleep } from "node:timers/promises";

type WaitLimit = { maxAttempts: number; timeoutMs?: never } | { timeoutMs: number; maxAttempts?: never };

type WaitOptions = WaitLimit & { intervalMs: number };

export async function waitUntil<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
	label: string,
	options: WaitOptions,
): Promise<T> {
	const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
	const maxAttempts = options.maxAttempts ?? Infinity;

	for (let attempt = 1; ; attempt++) {
		const value = await read();

		if (done(value)) {
			return value;
		}

		if (attempt >= maxAttempts || Date.now() > deadline) {
			throw new Error(`${label} did not reach the expected state; last observed ${JSON.stringify(value)}`);
		}

		await sleep(options.intervalMs);
	}
}
