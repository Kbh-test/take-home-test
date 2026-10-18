import type { ClientBase, Pool } from "pg";

import { withTransaction } from "../db/pool";
import { lockReferenceAndFindConflict } from "../db/reference_conflict";
import { extractReference } from "../forms/reference";

async function openTicket(
	client: ClientBase,
	formId: string,
	reason: string,
): Promise<void> {
	await client.query(
		"INSERT INTO dead_letters (inbound_form_id, reason) VALUES ($1, $2)",
		[formId, reason],
	);
}

export function ingestForm(pool: Pool, payload: unknown): Promise<void> {
	const reference = extractReference(payload);
	const json = JSON.stringify(payload);

	return withTransaction(pool, async (client) => {
		const inserted = await client.query<{ id: string }>(
			`INSERT INTO inbound_forms (application_reference, payload, status)
			VALUES ($1, $2::jsonb, $3)
			ON CONFLICT (payload_hash) DO NOTHING
			RETURNING id`,
			[reference, json, reference ? "received" : "blocked"],
		);
		const formId = inserted.rows[0]?.id;

		if (!formId) {
			await client.query(
				`UPDATE inbound_forms
				SET received_count = received_count + 1, last_received_at = now()
				WHERE payload_hash = payload_sha256($1::jsonb)`,
				[json],
			);
			return;
		}

		if (!reference) {
			await openTicket(client, formId, "Missing application_reference");
			return;
		}

		const conflictId = await lockReferenceAndFindConflict(client, reference, formId);

		if (conflictId) {
			await client.query(
				"UPDATE inbound_forms SET status = 'blocked' WHERE id = $1 AND status = 'received'",
				[formId],
			);
			await openTicket(
				client,
				formId,
				`application_reference already accepted on form ${conflictId}`,
			);
			return;
		}

		await client.query(
			"INSERT INTO jobs (inbound_form_id, type) VALUES ($1, 'process_form')",
			[formId],
		);
	});
}
