import type { Pool } from "pg";

import { findTransformedForm } from "../db/transformed_forms";
import { sendEmail } from "../providers/sendgrid";
import type { Email } from "../providers/types";
import { callProvider, JobError } from "./provider";

export async function sendFormEmail(
	pool: Pool,
	inboundFormId: string,
	send = sendEmail,
): Promise<void> {
	const form = await findTransformedForm(pool, inboundFormId);

	if (!form) {
		throw new JobError("Transformed form not found");
	}

	const email: Email = {
		to: "happyforms@bots.com",
		from: "forms@healthtech-1.example",
		subject: `Form ingested: ${form.applicationReference}`,
		body: `Application ${form.applicationReference} was ingested.`,
	};

	await callProvider("SendGrid", (signal) => send(email, signal));
}
