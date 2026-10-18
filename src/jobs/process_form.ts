import type { Pool } from "pg";

import { withTransaction } from "../db/pool";
import { openTicket } from "../db/tickets";
import { insertTransformedForm } from "../db/transformed_forms";
import { transform } from "../forms/transform";
import { lookupPostcode } from "../providers/idealpostcodes";
import type { FormStatus } from "../types";
import { callProvider, JobError } from "./provider";

type InboundFormRow = {
	payload: unknown;
	status: FormStatus;
};

export async function processForm(
	pool: Pool,
	inboundFormId: string,
	geocode = lookupPostcode,
): Promise<void> {
	const { rows } = await pool.query<InboundFormRow>(
		"SELECT payload, status FROM inbound_forms WHERE id = $1",
		[inboundFormId],
	);
	const inbound = rows[0];

	if (!inbound) {
		throw new JobError("Inbound form not found");
	}

	if (inbound.status !== "received") {
		return;
	}

	const result = transform(inbound.payload);

	if (!result.ok) {
		await withTransaction(pool, async (client) => {
			const { rowCount } = await client.query(
				"UPDATE inbound_forms SET status = 'blocked' WHERE id = $1 AND status = 'received'",
				[inboundFormId],
			);

			if (rowCount === 0) {
				return;
			}

			await openTicket(client, inboundFormId, "Validation failed: " + result.reason);
		});
		return;
	}

	const { form } = result;
	const { body: coordinates } = await callProvider("Geocoder", (signal) =>
		geocode(form.postcode, signal),
	);

	if (!coordinates) {
		throw new JobError("Geocoder returned no coordinates");
	}

	await withTransaction(pool, async (client) => {
		const { rowCount } = await client.query(
			"UPDATE inbound_forms SET status = 'transformed' WHERE id = $1 AND status = 'received'",
			[inboundFormId],
		);

		if (rowCount === 0) {
			return;
		}

		await insertTransformedForm(client, inboundFormId, form, coordinates);
		await client.query(
			`INSERT INTO jobs (inbound_form_id, type)
			VALUES ($1, 'send_email'), ($1, 'deliver_formbot')
			ON CONFLICT (inbound_form_id, type) DO NOTHING`,
			[inboundFormId],
		);
	});
}
