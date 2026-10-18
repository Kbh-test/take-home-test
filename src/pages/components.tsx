import type { JobSummary, RequestSummary, RetryTicket } from "./types";
import { RetryTicketForm } from "./RetryTicketForm";

export function JobBadge({ job }: { job: RequestSummary["jobs"][number] }) {
	return (
		<span className="job">
			{job.type.replaceAll("_", " ")}: {job.status}
			{job.attempts > 0 ? ` · ${job.attempts} attempts` : ""}
		</span>
	);
}

export function TicketRetry({ ticket, onRequeued }: { ticket: RetryTicket; onRequeued: () => void }) {
	return (
		<div className="ticket">
			<span>{ticket.reason}</span>
			<RetryTicketForm ticketId={ticket.id} jobType={ticket.jobType} onRequeued={onRequeued} />
		</div>
	);
}

export function RequestCard({ request, onRequeued }: { request: RequestSummary; onRequeued: () => void }) {
	const receivedAt = new Date(request.lastReceivedAt).toLocaleString("en-GB", {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: "UTC",
	});
	return (
		<article className="request">
			<div className="request-top">
				<span className="request-ref">{request.reference || "No application reference"}</span>
				<span className="badge">{request.status}</span>
			</div>
			<div className="jobs">
				{request.jobs.length > 0
					? request.jobs.map((job) => <JobBadge key={job.type} job={job} />)
					: <span className="job">Waiting for processing</span>}
			</div>
			<p className="meta">
				Received {receivedAt} UTC
				{request.receivedCount > 1 ? ` · ${request.receivedCount} duplicate deliveries` : ""}
			</p>
			{(request.missingFields?.length ?? 0) > 0 && (
				<p className="ticket">Missing or blank fields: {request.missingFields?.join(", ")}</p>
			)}
			{request.tickets.map((ticket) => (
				<TicketRetry key={ticket.id} ticket={ticket} onRequeued={onRequeued} />
			))}
		</article>
	);
}

export function JobRow({ job, onRequeued }: { job: JobSummary; onRequeued: () => void }) {
	const statusMessage = job.status === "pending"
		? `Scheduled ${new Date(job.runAfter).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`
		: job.status === "running"
			? "In progress"
			: job.status === "dead"
				? "Review ticket required"
				: "Completed";
	return (
		<div className="row">
			<div>
				<div className="job-name">{job.type.replaceAll("_", " ")}</div>
				<div className="muted">{job.reference || job.formId}</div>
			</div>
			<span className={`status ${job.status}`}>{job.status}</span>
			<span>{job.attempts} attempts</span>
			{job.ticketId
				? <RetryTicketForm ticketId={job.ticketId} jobType={job.type} onRequeued={onRequeued} />
				: <span className="muted">{statusMessage}</span>}
		</div>
	);
}
