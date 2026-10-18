import type { Pool } from "pg";

import type { TransformedFormSchema } from "../forms/schemas/transformed_schema";
import { calendarDateToUtc } from "../helpers";

type TransformedFormRow = {
	application_reference: string;
	session_id: string;
	first_name: string;
	last_name: string;
	email: string;
	gender: TransformedFormSchema["gender"];
	date_of_birth: string;
	phone_number: string | null;
	mobile_number: string;
	address_line_1: string;
	address_line_2: string;
	address_line_3: string | null;
	postcode: string;
	country: string;
	latitude: number;
	longitude: number;
};

export async function findTransformedForm(
	pool: Pool,
	inboundFormId: string,
): Promise<TransformedFormSchema | null> {
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
		return null;
	}

	return {
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
}
