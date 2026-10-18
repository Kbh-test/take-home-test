import { type } from "arktype";

const WithReference = type({ application_reference: /\S/ });

export function extractReference(payload: unknown): string | null {
	const result = WithReference(payload);

	return result instanceof type.errors ? null : result.application_reference;
}
