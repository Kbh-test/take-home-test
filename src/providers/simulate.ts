import { setTimeout as sleep } from "node:timers/promises";

export async function simulateRequest(signal?: AbortSignal): Promise<boolean> {
	await sleep(1_000, undefined, { signal });

	return Math.random() < 0.95;
}
