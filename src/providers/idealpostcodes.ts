import type { HttpResponse } from "./httpresponse";
import { simulateRequest } from "./simulate";
import type { Coordinates } from "./types";

export const lookupPostcode = async (
	_postcode: string,
	signal?: AbortSignal,
): Promise<HttpResponse<Coordinates>> => {
	const success = await simulateRequest(signal);

	return {
		statusCode: success ? 200 : 500,
		body: success ? { longitude: 50.05, latitude: -5.05 } : undefined,
	};
};
