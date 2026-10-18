import type { HttpResponse } from "../providers/httpresponse";

const PROVIDER_TIMEOUT_MS = 5_000;

export class JobError extends Error {}

export async function callProvider<T>(
	provider: string,
	request: (signal: AbortSignal) => Promise<HttpResponse<T>>,
	timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<HttpResponse<T>> {
	const signal = AbortSignal.timeout(timeoutMs);
	let response: HttpResponse<T>;

	try {
		response = await request(signal);
	} catch (error) {
		throw signal.aborted ? new JobError(`${provider} timed out after ${timeoutMs}ms`) : error;
	}

	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new JobError(`${provider} returned ${response.statusCode}`);
	}

	return response;
}
