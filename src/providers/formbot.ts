import type { TransformedFormSchema } from "../forms/schemas/transformed_schema";
import type { HttpResponse } from "./httpresponse";

export const deliverForm = async ({ idempotencyKey, form }: {
	idempotencyKey: string;
	form: TransformedFormSchema;
}): Promise<HttpResponse<void>> => {
	const randomNumber = Math.random();

	await new Promise((resolve) => setTimeout(resolve, 1000));
	return {
		statusCode: randomNumber < 0.95 ? 200 : 500,
		body: undefined,
	};
};
