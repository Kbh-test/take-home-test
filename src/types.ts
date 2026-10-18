import { type } from "arktype";
import type { Pool } from "pg";

import type { TransformedFormSchema } from "./forms/schemas/transformed_schema";
import { calendarDate } from "./helpers";

export const IngestedGender = type("'male' | 'female' | 'other'");

export type IngestedGender = typeof IngestedGender.infer;

export const IngestedAddress = type({
	address_line_1: "string",
	address_line_2: "string",
	"address_line_3?": "string",
	postcode: "string",
	country: "string",
});

export type IngestedAddress = typeof IngestedAddress.infer;

export const IngestedForm = type({
	session_id: "string",
	application_reference: "string",
	name: "string",
	email: "string",
	gender: IngestedGender,
	date_of_birth: calendarDate,
	"phone_number?": "string",
	mobile_number: "string",
	address: IngestedAddress,
});

export type IngestedForm = typeof IngestedForm.infer;

export type MappedForm = Omit<
	TransformedFormSchema,
	"latitude" | "longitude"
>;

export type Gender = MappedForm["gender"];

export type TransformResult =
	| {
			ok: true;
			form: MappedForm;
	  }
	| {
			ok: false;
			reason: string;
	  };

export type JobType = "process_form" | "send_email" | "deliver_formbot";

export type Job = {
	id: string;
	inboundFormId: string;
	type: JobType;
	attempts: number;
};

export type JobStatus = "pending" | "running" | "done" | "dead";

export type FormStatus = "received" | "transformed" | "blocked";

export type OpenTicket = {
	id: string;
	createdAt: Date;
	formId: string;
	jobType: JobType | null;
	reason: string;
};

export type ServiceOptions = {
	pool: Pool;
	connectionString: string;
	port: number | string;
};

export type Service = {
	ready: Promise<void>;
	stop: () => Promise<void>;
	workerStopped: Promise<void>;
};
