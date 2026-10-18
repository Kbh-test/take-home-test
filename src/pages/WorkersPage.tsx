import { JobRow } from "./components";
import type { JobSummary } from "./types";
import { usePolling } from "./usePolling";

export function WorkersPage() {
	const { data: jobs, error, loading, refresh } = usePolling<JobSummary>("/api/jobs");
	const requeued = () => refresh();

	return (
		<main>
				<div className="eyebrow">Healthtech-1 · Operations</div>
				<h1>Work queue</h1>
				<nav><a href="/">Requests</a><a href="/workers">Work queue</a></nav>
				<section className="card">
					<div className="head">
						<div><strong>All jobs</strong><p className="muted">Refreshes every five seconds</p></div>
						<button id="refresh" onClick={refresh} type="button">Refresh</button>
					</div>
					<div id="jobs" aria-live="polite">
						{loading && jobs.length === 0
							? <p>Loading jobs…</p>
							: error && jobs.length === 0
								? <p role="alert">{error}</p>
								: jobs.length > 0
									? jobs.map((job) => <JobRow key={job.id} job={job} onRequeued={requeued} />)
									: <p>No jobs have been queued yet.</p>}
					</div>
					{error && jobs.length > 0 && <p role="status">Refresh failed: {error}</p>}
					<p id="message" role="status" />
				</section>
		</main>
	);
}
