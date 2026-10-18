import type { ClientBase, Pool } from "pg";

import type { FormStatus, OpenTicket } from "../types";

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

export async function listOpenTickets(pool: Pool): Promise<OpenTicket[]> {
	const { rows } = await pool.query<OpenTicket>(
		`SELECT d.id, d.created_at AS "createdAt", d.inbound_form_id AS "formId",
			j.type AS "jobType", d.reason
		FROM dead_letters d
		LEFT JOIN jobs j ON j.id = d.job_id
		WHERE d.resolved_at IS NULL
		ORDER BY d.created_at, d.id`,
	);

	return rows;
}

type LockedTicket = { formId: string; jobId: string | null; resolved: boolean };

export async function lockTicket(
	client: ClientBase,
	ticketId: string,
): Promise<LockedTicket | null> {
	const { rows } = await client.query<LockedTicket>(
		`SELECT inbound_form_id AS "formId", job_id AS "jobId", resolved_at IS NOT NULL AS resolved
		FROM dead_letters WHERE id = $1
		FOR UPDATE`,
		[ticketId],
	);

	return rows[0] ?? null;
}

export async function resolveTicket(
	client: ClientBase,
	ticketId: string,
	resolvedBy: string,
	resolution: "requeued" | "closed",
	note: string | null = null,
): Promise<boolean> {
	const { rowCount } = await client.query(
		`UPDATE dead_letters
		SET resolved_at = now(), resolved_by = $2, resolution = $3, resolution_note = $4
		WHERE id = $1 AND resolved_at IS NULL`,
		[ticketId, resolvedBy, resolution, note],
	);

	return rowCount === 1;
}

type LockedForm = { status: FormStatus; payload: unknown };

export async function lockForm(client: ClientBase, formId: string): Promise<LockedForm> {
	const { rows } = await client.query<LockedForm>(
		"SELECT status, payload FROM inbound_forms WHERE id = $1 FOR UPDATE",
		[formId],
	);

	return rows[0];
}

export async function requeueBlockedForm(
	client: ClientBase,
	formId: string,
	reference: string,
): Promise<boolean> {
	const { rowCount } = await client.query(
		`UPDATE inbound_forms SET application_reference = $2, status = 'received'
		WHERE id = $1 AND status = 'blocked'`,
		[formId, reference],
	);

	return rowCount === 1;
}
