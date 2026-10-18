import { useState } from "react";

import { RequestCard } from "./components";
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
		<>
			<style>{`
				:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172b27; background: #f5f7f2; }
				* { box-sizing: border-box; }
				body { margin: 0; min-height: 100vh; }
				main { width: min(920px, calc(100% - 40px)); margin: 0 auto; padding: 72px 0; }
				.eyebrow { color: #367663; font-size: 12px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
				h1 { max-width: 650px; margin: 18px 0; font-size: clamp(38px, 7vw, 64px); line-height: 1.02; letter-spacing: -.045em; }
				.intro { max-width: 610px; color: #52645f; font-size: 18px; line-height: 1.65; }
				.card { margin-top: 28px; padding: 28px; border: 1px solid #dce5dc; border-radius: 18px; background: white; box-shadow: 0 16px 45px #1a3b2910; }
				h2 { margin: 0 0 9px; font-size: 19px; }
				p { color: #52645f; line-height: 1.6; }
				.endpoint { display: inline-flex; gap: 10px; align-items: center; margin: 10px 0 18px; padding: 8px 12px; border-radius: 8px; background: #eef5ef; color: #204b3f; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; }
				.method { font-weight: 800; color: #34725d; }
				pre { overflow-x: auto; margin: 0; padding: 20px; border-radius: 12px; background: #172b27; color: #e7f2e8; font-size: 13px; line-height: 1.65; }
				.note { margin-bottom: 0; font-size: 14px; }
				nav { display: flex; gap: 18px; margin-top: 28px; font-size: 14px; }
				nav a { color: #28634e; font-weight: 650; text-decoration-thickness: 1px; text-underline-offset: 3px; }
				.section-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
				button { font: inherit; cursor: pointer; }
				#refresh { border: 1px solid #cbd9d0; border-radius: 8px; background: white; color: #285443; padding: 8px 12px; }
				#requests { display: grid; gap: 12px; margin-top: 20px; }
				.request { border: 1px solid #e1e8e1; border-radius: 12px; padding: 16px; }
				.request-top { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; }
				.request-ref { font-weight: 700; }
				.badge { display: inline-block; border-radius: 99px; padding: 4px 9px; background: #eef5ef; color: #285443; font-size: 12px; font-weight: 700; text-transform: capitalize; }
				.jobs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
				.job { border-radius: 6px; padding: 5px 8px; background: #f3f5f2; color: #53635d; font-size: 12px; }
				.meta { margin: 10px 0 0; font-size: 13px; }
				.ticket { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 10px; margin-top: 12px; border-top: 1px solid #e8ece7; padding-top: 12px; color: #854b31; font-size: 13px; }
				.retry { border: 0; border-radius: 7px; background: #28634e; color: white; padding: 8px 11px; font-weight: 650; }
				.retry:disabled, #refresh:disabled { opacity: .55; cursor: wait; }
				.retry-form { display: grid; gap: 10px; min-width: 240px; margin-top: 10px; color: #52645f; }
				.retry-form label { display: grid; gap: 5px; }
				.retry-form input:not([type=checkbox]) { width: 100%; border: 1px solid #cbd9d0; border-radius: 6px; padding: 8px; font: inherit; }
				.retry-form .confirm { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; }
				.retry-actions { display: flex; gap: 8px; }
				.retry-error { margin: 0; color: #a34b32; }
				#message { min-height: 20px; margin: 12px 0 0; font-size: 14px; }
				.empty { border: 1px dashed #d3ded4; border-radius: 10px; padding: 18px; color: #65736d; }
				@media (max-width: 560px) { main { padding: 44px 0; } .card { padding: 20px; } }
			`}</style>
			<main>
				<div className="eyebrow">Healthtech-1 · Registration API</div>
				<h1>Registration forms, ready for processing.</h1>
				<nav><a href="/">Requests</a><a href="/workers">Work queue</a></nav>
				<section className="card" aria-labelledby="requests-title">
					<div className="section-head">
						<div><h2 id="requests-title">All requests</h2><p>Current processing status for every stored submission.</p></div>
						<button id="refresh" onClick={refresh} type="button">Refresh</button>
					</div>
					<div id="requests" aria-live="polite">
						{loading && requests.length === 0
							? <div className="empty">Loading requests…</div>
							: error && requests.length === 0
								? <div className="empty">{error}</div>
								: requests.length > 0
									? requests.map((request) => <RequestCard key={request.id} request={request} onRequeued={onRequeued} />)
									: <div className="empty">No requests yet. Submit a form to see it here.</div>}
					</div>
					{error && requests.length > 0 && <p role="status">Refresh failed: {error}</p>}
					<p id="message" role="status">{message}</p>
				</section>
				<section className="card" aria-labelledby="endpoint-title">
					<h2 id="endpoint-title">Submit a form</h2>
					<p>Send a JSON payload to the ingest endpoint. A successful request is accepted for background processing.</p>
					<div className="endpoint"><span className="method">POST</span><span>/ingest</span></div>
					<pre><code>{`curl -X POST http://localhost:3000/ingest \\
  -H 'Content-Type: application/json' \\
  -d '{
    "session_id": "c8267b77-d796-451e-9948-e82f56412b56",
    "application_reference": "GRU-123089-2026",
    "name": "John Doe",
    "email": "john.doe@example.com",
    "gender": "male",
    "date_of_birth": "1990-01-01",
    "phone_number": "07123456789",
    "mobile_number": "07123456789",
    "address": {
      "address_line_1": "50C Romford Road",
      "address_line_2": "Stratford",
      "address_line_3": "London",
      "postcode": "E15 4BZ",
      "country": "United Kingdom"
    }
  }'`}</code></pre>
					<p className="note">The endpoint responds with <code>202 Accepted</code> when the form is queued.</p>
				</section>
			</main>
		</>
	);
}
