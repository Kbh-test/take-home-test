import type { Pool } from "pg";

import { findTransformedForm } from "../db/transformed_forms";
import { deliverForm } from "../providers/formbot";
import { callProvider, JobError } from "./provider";

export async function deliverToFormBot(
	pool: Pool,
	inboundFormId: string,
	deliver = deliverForm,
): Promise<void> {
	const form = await findTransformedForm(pool, inboundFormId);

	if (!form) {
		throw new JobError("Transformed form not found");
	}

	await callProvider("FORM-BOT", (signal) => deliver({ idempotencyKey: inboundFormId, form }, signal));
}
