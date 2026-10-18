import type { HttpResponse } from "./httpresponse";
import { simulateRequest } from "./simulate";
import type { FormBotDelivery } from "./types";

export const deliverForm = async (
	_delivery: FormBotDelivery,
	signal?: AbortSignal,
): Promise<HttpResponse<void>> => ({
	statusCode: (await simulateRequest(signal)) ? 200 : 500,
	body: undefined,
});
