import { useState } from "react";

import { CurlCommand, RequestCard } from "./components";
import type { RequestSummary } from "./types";
import { usePolling } from "./usePolling";

export function HomePage() {
	const { data: requests, error, loading, refresh } = usePolling<RequestSummary>("/api/requests");
	const [message, setMessage] = useState("");
	const onRequeued = () => {
		setMessage("Request requeued.");
		refresh();
	};

	return (
		<main>
			<div className="eyebrow">Healthtech-1 · Registration API</div>
			<h1>Registration forms, ready for processing.</h1>
			<nav>
				<a href="/">Requests</a>
				<a href="/workers">Work queue</a>
			</nav>
			<section className="card" aria-labelledby="requests-title">
				<div className="section-head">
					<div>
						<h2 id="requests-title">All requests</h2>
						<p>Current processing status for every stored submission.</p>
					</div>
					<button id="refresh" onClick={refresh} type="button">
						Refresh
					</button>
				</div>
				<div id="requests" aria-live="polite">
					{loading && requests.length === 0 ? (
						<div className="empty">Loading requests…</div>
					) : error && requests.length === 0 ? (
						<div className="empty">{error}</div>
					) : requests.length > 0 ? (
						requests.map((request) => (
							<RequestCard
								key={request.id}
								request={request}
								onRequeued={onRequeued}
							/>
						))
					) : (
						<div className="empty">No requests yet. Submit a form to see it here.</div>
					)}
				</div>
				{error && requests.length > 0 && <p role="status">Refresh failed: {error}</p>}
				<p id="message" role="status">
					{message}
				</p>
			</section>
			<section className="card" aria-labelledby="endpoint-title">
				<h2 id="endpoint-title">Submit a form</h2>
				<p>
					Send a JSON payload to the ingest endpoint. A successful request is accepted for background processing.
				</p>
				<div className="endpoint">
					<span className="method">POST</span>
					<span>/ingest</span>
				</div>
				<CurlCommand />
				<p className="note">
					The endpoint responds with <code>202 Accepted</code> when the form is queued.
				</p>
			</section>
		</main>
	);
}
