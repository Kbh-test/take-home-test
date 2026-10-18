import type { ClientBase } from "pg";

export async function lockReferenceAndFindConflict(
	client: ClientBase,
	reference: string,
	formId: string,
): Promise<string | null> {
	await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
		reference,
	]);

	const { rows } = await client.query<{ id: string }>(
		`SELECT id FROM inbound_forms
		WHERE application_reference = $1
			AND status IN ('received', 'transformed')
			AND id <> $2
		ORDER BY first_received_at
		LIMIT 1`,
		[reference, formId],
	);

	return rows[0]?.id ?? null;
}
