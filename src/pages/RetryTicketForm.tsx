import { useState, type FormEvent } from "react";

type RetryTicketFormProps = {
	ticketId: string;
	jobType: string | null;
	onRequeued: () => void;
};

export function RetryTicketForm({ ticketId, jobType, onRequeued }: RetryTicketFormProps) {
	const [expanded, setExpanded] = useState(false);
	const [note, setNote] = useState("");
	const [confirmNotDelivered, setConfirmNotDelivered] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const needsDeliveryCheck = jobType === "deliver_formbot";

	const requeue = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!note.trim() || (needsDeliveryCheck && !confirmNotDelivered)) return;

		setPending(true);
		setError(null);
		try {
			const response = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/requeue`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ note: note.trim(), confirmNotDelivered }),
			});
			const result: unknown = await response.json();
			if (!response.ok) {
				const message =
					typeof result === "object" && result !== null && "error" in result
						? String(result.error)
						: "Could not requeue this request";
				throw new Error(message);
			}
			onRequeued();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not requeue this request");
		} finally {
			setPending(false);
		}
	};

	if (!expanded) {
		return <button className="retry" type="button" onClick={() => setExpanded(true)}>Retry</button>;
	}

	return (
		<form className="retry-form" onSubmit={requeue}>
			<label>
				Audit note
				<input value={note} onChange={(event) => setNote(event.currentTarget.value)} required />
			</label>
			{needsDeliveryCheck && (
				<label className="confirm">
					<input
						type="checkbox"
						checked={confirmNotDelivered}
						onChange={(event) => setConfirmNotDelivered(event.currentTarget.checked)}
					/>
					I checked FORM-BOT and confirmed this form was not delivered.
				</label>
			)}
			{error && <p className="retry-error" role="alert">{error}</p>}
			<div className="retry-actions">
				<button className="retry" type="submit" disabled={pending || !note.trim() || (needsDeliveryCheck && !confirmNotDelivered)}>
					{pending ? "Requeueing…" : "Confirm retry"}
				</button>
				<button type="button" onClick={() => setExpanded(false)}>Cancel</button>
			</div>
		</form>
	);
}
