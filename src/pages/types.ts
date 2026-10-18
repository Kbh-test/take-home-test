export type RequestJob = {
	type: string;
	status: string;
	attempts: number;
};

export type RetryTicket = {
	id: string;
	reason: string;
	jobType: string | null;
};

export type RequestSummary = {
	id: string;
	reference: string | null;
	status: string;
	receivedCount: number;
	lastReceivedAt: string;
	jobs: RequestJob[];
	tickets: RetryTicket[];
	missingFields?: string[];
};

export type JobSummary = {
	id: string;
	formId: string;
	reference: string | null;
	type: string;
	status: "pending" | "running" | "done" | "dead";
	attempts: number;
	runAfter: string;
	lastError: string | null;
	ticketId: string | null;
};
