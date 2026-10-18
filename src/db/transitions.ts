import type { FormStatus, JobStatus } from "../types";

type TransitionMap<S extends string> = Record<S, readonly S[]>;

export const JOB_TRANSITIONS: TransitionMap<JobStatus> = {
	pending: ["running"],
	running: ["done", "pending", "dead"],
	dead: ["pending"],
	done: ["pending"],
};

export const FORM_TRANSITIONS: TransitionMap<FormStatus> = {
	received: ["transformed", "blocked"],
	blocked: ["received"],
	transformed: [],
};

export function canTransition<S extends string>(
	map: TransitionMap<S>,
	from: S,
	to: S,
): boolean {
	return map[from].includes(to);
}
