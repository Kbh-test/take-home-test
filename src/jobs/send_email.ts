import type { Pool } from "pg";

import { sendEmail } from "../providers/sendgrid";

export async function sendFormEmail(
	pool: Pool,
	inboundFormId: string,
	send = sendEmail,
): Promise<void> {
	const { rows } = await pool.query<{ application_reference: string }>(
		"SELECT application_reference FROM transformed_forms WHERE inbound_form_id = $1",
		[inboundFormId],
	);
	const form = rows[0];

	if (!form) {
		throw new Error("Transformed form not found");
	}

	const response = await send({
		to: "happyforms@bots.com",
		from: "forms@healthtech-1.example",
		subject: `Form ingested: ${form.application_reference}`,
		body: `Application ${form.application_reference} was ingested.`,
	});

	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(`SendGrid returned ${response.statusCode}`);
	}
}
