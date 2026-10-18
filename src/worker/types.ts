import type { Pool } from "pg";

import type { JobType } from "../types";

export type JobHandler = (pool: Pool, inboundFormId: string) => Promise<void>;

export type WorkerOptions = {
	pool: Pool;
	connectionString: string;
	handlers: Record<JobType, JobHandler>;
	pollIntervalMs?: number;
	retryDelayMs?: (attempts: number) => number;
};

export type Worker = {
	stop: () => Promise<void>;
	stopped: Promise<void>;
};
