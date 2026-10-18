import type { ClientBase } from "pg";

export async function openTicket(
	client: ClientBase,
	formId: string,
	reason: string,
	jobId: string | null = null,
): Promise<void> {
	await client.query(
		"INSERT INTO dead_letters (inbound_form_id, job_id, reason) VALUES ($1, $2, $3)",
		[formId, jobId, reason],
	);
}
