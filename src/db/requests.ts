import type { Pool } from "pg";
import { missingFields } from "../forms/missing_fields";

export async function listRecentRequests(pool: Pool) {
	const { rows } = await pool.query(
		`SELECT f.id, f.payload, f.application_reference AS "reference", f.status,
			f.received_count AS "receivedCount", f.last_received_at AS "lastReceivedAt",
			COALESCE((SELECT json_agg(json_build_object(
				'type', j.type, 'status', j.status, 'attempts', j.attempts
			) ORDER BY j.id) FROM jobs j WHERE j.inbound_form_id = f.id), '[]'::json) AS jobs,
			COALESCE((SELECT json_agg(json_build_object(
				'id', d.id, 'reason', d.reason, 'jobType', j.type
			) ORDER BY d.created_at DESC, d.id DESC)
			FROM dead_letters d LEFT JOIN jobs j ON j.id = d.job_id
			WHERE d.inbound_form_id = f.id AND d.resolved_at IS NULL), '[]'::json) AS tickets
		FROM inbound_forms f ORDER BY f.last_received_at DESC`,
	);

	return rows.map(({ payload, ...request }) => ({
		...request,
		missingFields: missingFields(payload),
	}));
}

export async function listRecentJobs(pool: Pool) {
	const { rows } = await pool.query(
		`SELECT j.id, j.inbound_form_id AS "formId", f.application_reference AS reference,
			j.type, j.status, j.attempts, j.run_after AS "runAfter", j.last_error AS "lastError",
			(SELECT d.id FROM dead_letters d WHERE d.job_id = j.id AND d.resolved_at IS NULL
			 ORDER BY d.created_at DESC LIMIT 1) AS "ticketId"
		FROM jobs j JOIN inbound_forms f ON f.id = j.inbound_form_id
		ORDER BY j.id DESC`,
	);

	return rows;
}
