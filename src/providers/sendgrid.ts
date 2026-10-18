import type { HttpResponse } from "./httpresponse";
import { simulateRequest } from "./simulate";
import type { Email } from "./types";

export const sendEmail = async (_email: Email, signal?: AbortSignal): Promise<HttpResponse<void>> => ({
	statusCode: (await simulateRequest(signal)) ? 200 : 500,
	body: undefined,
});
