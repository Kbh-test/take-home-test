import { userInfo } from "node:os";
import type { ClientBase, Pool } from "pg";

import { lockJob, lockProcessFormJob, requeueDeadJob, scheduleProcessFormJob } from "../db/jobs";
import { withTransaction } from "../db/pool";
import { lockReferenceAndFindConflict } from "../db/reference_conflict";
import { lockForm, lockTicket, requeueBlockedForm, resolveTicket } from "../db/tickets";
import { canTransition, FORM_TRANSITIONS, JOB_TRANSITIONS } from "../db/transitions";
import { extractReference } from "../forms/reference";

export { listOpenTickets as listTickets } from "../db/tickets";

export async function requeueTicket(
	pool: Pool,
	ticketId: string,
	options: { confirmNotDelivered?: boolean } = {},
): Promise<void> {
	const resolvedBy = userInfo().username;

	await withTransaction(pool, async (client) => {
		const ticket = await lockOpenTicket(client, ticketId);

		if (ticket.jobId) {
			await requeueJob(client, ticket.jobId, options.confirmNotDelivered ?? false);
		} else {
			await requeueForm(client, ticket.formId);
		}

		await resolve(client, ticketId, resolvedBy, "requeued");
	});
}

export async function closeTicket(pool: Pool, ticketId: string, note: string): Promise<void> {
	const trimmed = note.trim();

	if (!trimmed) {
		throw new Error("close needs a non-blank --note");
	}

	const resolvedBy = userInfo().username;

	await withTransaction(pool, async (client) => {
		await lockOpenTicket(client, ticketId);
		await resolve(client, ticketId, resolvedBy, "closed", trimmed);
	});
}

async function lockOpenTicket(client: ClientBase, ticketId: string) {
	const ticket = await lockTicket(client, ticketId);

	if (!ticket) {
		throw new Error(`ticket ${ticketId} not found`);
	}

	if (ticket.resolved) {
		throw new Error(`ticket ${ticketId} is already resolved`);
	}

	return ticket;
}

async function requeueJob(
	client: ClientBase,
	jobId: string,
	confirmNotDelivered: boolean,
): Promise<void> {
	const job = await lockJob(client, jobId);

	if (!canTransition(JOB_TRANSITIONS, job.status, "pending") || job.status !== "dead") {
		throw new Error(`job is ${job.status}; only dead jobs can be requeued`);
	}

	if (job.type === "deliver_formbot" && !confirmNotDelivered) {
		throw new Error(
			"deliver_formbot may already have reached FORM-BOT; verify it was not delivered, then rerun with --confirm-not-delivered",
		);
	}

	if (!(await requeueDeadJob(client, jobId))) {
		throw new Error(`job ${jobId} is no longer dead; nothing was changed`);
	}
}

async function requeueForm(client: ClientBase, formId: string): Promise<void> {
	const form = await lockForm(client, formId);

	if (!canTransition(FORM_TRANSITIONS, form.status, "received")) {
		throw new Error(`form is ${form.status}; only blocked forms can be requeued`);
	}

	const reference = extractReference(form.payload);

	if (!reference) {
		throw new Error("stored payload has no application_reference; close the ticket or fix the mapper");
	}

	const conflictId = await lockReferenceAndFindConflict(client, reference, formId);

	if (conflictId) {
		throw new Error(`another accepted submission holds the reference (form ${conflictId})`);
	}

	if (!(await requeueBlockedForm(client, formId, reference))) {
		throw new Error(`form ${formId} is no longer blocked; nothing was changed`);
	}

	const processJob = await lockProcessFormJob(client, formId);

	if (
		processJob &&
		(!canTransition(JOB_TRANSITIONS, processJob.status, "pending") ||
			!["dead", "done"].includes(processJob.status))
	) {
		throw new Error(
			`process_form job is ${processJob.status}; only dead or done process_form jobs can be reset`,
		);
	}

	if (!(await scheduleProcessFormJob(client, formId))) {
		throw new Error("process_form job is already pending or running; nothing was changed");
	}
}

async function resolve(
	client: ClientBase,
	ticketId: string,
	resolvedBy: string,
	resolution: "requeued" | "closed",
	note: string | null = null,
): Promise<void> {
	if (!(await resolveTicket(client, ticketId, resolvedBy, resolution, note))) {
		throw new Error(`ticket ${ticketId} is already resolved`);
	}
}
