import { parseArgs } from "node:util";
import type { Pool } from "pg";

import { createPool } from "../db/pool";
import { errorMessage } from "../helpers";
import type { OpenTicket } from "../types";
import { closeTicket, listTickets, requeueTicket } from "./commands";

type Command =
	| { name: "list" }
	| { name: "requeue"; ticketId: string; confirmNotDelivered: boolean; note?: string }
	| { name: "close"; ticketId: string; note: string };

const USAGE = `usage:
	npm run cli -- list
	npm run cli -- requeue <ticketId> [--note "<text>"] [--confirm-not-delivered]
	npm run cli -- close <ticketId> --note "<text>"`;

const TICKET_ID = /^[1-9][0-9]*$/;

export function parseCommand(args: string[]): Command {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			"confirm-not-delivered": { type: "boolean" },
			note: { type: "string" },
		},
	});
	const [name, ticketId] = positionals;
	const confirmNotDelivered = values["confirm-not-delivered"];
	const { note } = values;

	if (
		name === "list" &&
		positionals.length === 1 &&
		confirmNotDelivered === undefined &&
		note === undefined
	) {
		return { name };
	}

	if ((name !== "requeue" && name !== "close") || positionals.length !== 2) {
		throw new Error(USAGE);
	}

	if (!TICKET_ID.test(ticketId)) {
		throw new Error(`ticket id must be a positive integer, got "${ticketId}"`);
	}

	if (name === "requeue" && (note === undefined || note.trim())) {
		return {
			name,
			ticketId,
			confirmNotDelivered: confirmNotDelivered ?? false,
			...(note === undefined ? {} : { note: note.trim() }),
		};
	}

	if (name === "close" && note?.trim() && confirmNotDelivered === undefined) {
		return { name, ticketId, note: note.trim() };
	}

	if (name === "requeue" && note !== undefined && !note.trim()) {
		throw new Error("requeue needs a non-blank --note");
	}

	if (name === "close" && note !== undefined && !note.trim()) {
		throw new Error("close needs a non-blank --note");
	}

	throw new Error(USAGE);
}

function formatTicket(ticket: OpenTicket): string {
	return [
		ticket.id,
		ticket.createdAt.toISOString(),
		ticket.formId,
		ticket.jobType ?? "form",
		ticket.reasonCode,
		ticket.reason.replace(/[\t\r\n]/g, " "),
	].join("\t");
}

async function run(pool: Pool, command: Command): Promise<void> {
	switch (command.name) {
		case "list":
			for (const ticket of await listTickets(pool)) {
				console.log(formatTicket(ticket));
			}
			return;
		case "requeue":
			await requeueTicket(pool, command.ticketId, {
				confirmNotDelivered: command.confirmNotDelivered,
				note: command.note,
			});
			console.log(`ticket ${command.ticketId} requeued`);
			return;
		case "close":
			await closeTicket(pool, command.ticketId, command.note);
			console.log(`ticket ${command.ticketId} closed`);
	}
}

async function main(args: string[]): Promise<void> {
	const command = parseCommand(args);
	const pool = createPool();

	try {
		await run(pool, command);
	} finally {
		await pool.end();
	}
}

if (require.main === module) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(errorMessage(error));
		process.exitCode = 1;
	});
}
