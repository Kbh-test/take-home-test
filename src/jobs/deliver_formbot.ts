import type { Pool } from "pg";

import type { TransformedFormSchema } from "../forms/schemas/transformed_schema";
import { calendarDateToUtc } from "../helpers";
import { deliverForm } from "../providers/formbot";
import type { TransformedFormRow } from "../types";

export async function deliverToFormBot(
	pool: Pool,
	inboundFormId: string,
	deliver = deliverForm,
): Promise<void> {
	const { rows } = await pool.query<TransformedFormRow>(
		`SELECT application_reference, session_id, first_name, last_name, email,
			gender, date_of_birth::text, phone_number, mobile_number,
			address_line_1, address_line_2, address_line_3, postcode, country,
			latitude::float8, longitude::float8
		FROM transformed_forms WHERE inbound_form_id = $1`,
		[inboundFormId],
	);
	const row = rows[0];

	if (!row) {
		throw new Error("Transformed form not found");
	}

	const form: TransformedFormSchema = {
		applicationReference: row.application_reference,
		sessionId: row.session_id,
		firstName: row.first_name,
		lastName: row.last_name,
		email: row.email,
		gender: row.gender,
		dateOfBirth: calendarDateToUtc(row.date_of_birth),
		phoneNumber: row.phone_number ?? undefined,
		mobileNumber: row.mobile_number,
		addressLine1: row.address_line_1,
		addressLine2: row.address_line_2,
		addressLine3: row.address_line_3 ?? undefined,
		postcode: row.postcode,
		country: row.country,
		latitude: row.latitude,
		longitude: row.longitude,
	};
	const response = await deliver({ idempotencyKey: inboundFormId, form });

	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(`FORM-BOT returned ${response.statusCode}`);
	}
}
