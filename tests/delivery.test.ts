import { setTimeout as sleep } from "node:timers/promises";
import type { Pool } from "pg";

import type { TransformedFormSchema } from "../src/forms/schemas/transformed_schema";
import { deliverToFormBot } from "../src/jobs/deliver_formbot";
import { callProvider } from "../src/jobs/provider";
import { sendFormEmail } from "../src/jobs/send_email";
import type { deliverForm } from "../src/providers/formbot";
import type { sendEmail } from "../src/providers/sendgrid";
import { payloadWith, transformedWith } from "./fixtures/form";
import { createCleanup, createMigratedPool } from "./helpers/db";

const storedForm: TransformedFormSchema = {
	...transformedWith({ phoneNumber: undefined, addressLine3: undefined }),
	latitude: -5.05,
	longitude: 50.05,
};

describe("delivery handlers", () => {
	const cleanup = createCleanup();
	let pool: Pool;
	let inboundFormId: string;
	let send: jest.MockedFunction<typeof sendEmail>;
	let deliver: jest.MockedFunction<typeof deliverForm>;

	beforeEach(async () => {
		pool = await createMigratedPool(cleanup);
		send = jest.fn().mockResolvedValue({ statusCode: 202 });
		deliver = jest.fn().mockResolvedValue({ statusCode: 204 });

		const { rows } = await pool.query<{ id: string }>(
			`INSERT INTO inbound_forms (application_reference, payload, status)
			VALUES ($1, $2::jsonb, 'transformed') RETURNING id`,
			[storedForm.applicationReference, JSON.stringify(payloadWith())],
		);
		inboundFormId = rows[0].id;

		await pool.query(
			`INSERT INTO transformed_forms (
				inbound_form_id, application_reference, session_id, first_name, last_name,
				email, gender, date_of_birth, phone_number, mobile_number,
				address_line_1, address_line_2, address_line_3, postcode, country,
				latitude, longitude
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
			[
				inboundFormId, storedForm.applicationReference, storedForm.sessionId,
				storedForm.firstName, storedForm.lastName, storedForm.email, storedForm.gender,
				storedForm.dateOfBirth.toISOString().slice(0, 10), storedForm.phoneNumber ?? null,
				storedForm.mobileNumber, storedForm.addressLine1, storedForm.addressLine2,
				storedForm.addressLine3 ?? null, storedForm.postcode, storedForm.country,
				storedForm.latitude, storedForm.longitude,
			],
		);
	});

	afterEach(() => cleanup.run());

	it("emails the team with only the application reference", async () => {
		await sendFormEmail(pool, inboundFormId, send);

		expect(send.mock.calls).toStrictEqual([[{
			to: "happyforms@bots.com",
			from: "forms@healthtech-1.example",
			subject: `Form ingested: ${storedForm.applicationReference}`,
			body: `Application ${storedForm.applicationReference} was ingested.`,
		}, expect.any(AbortSignal)]]);
	});

	it("delivers the complete form with numeric coordinates, UTC date and undefined optional fields", async () => {
		await deliverToFormBot(pool, inboundFormId, deliver);

		expect(deliver.mock.calls).toStrictEqual([[{
			idempotencyKey: inboundFormId,
			form: storedForm,
		}, expect.any(AbortSignal)]]);
		expect(deliver.mock.calls[0][0].form.dateOfBirth.toISOString()).toBe("1990-01-01T00:00:00.000Z");
	});

	it("preserves optional fields when they are present", async () => {
		await pool.query(
			`UPDATE transformed_forms SET phone_number = '0001', address_line_3 = 'London'
			WHERE inbound_form_id = $1`,
			[inboundFormId],
		);

		await deliverToFormBot(pool, inboundFormId, deliver);

		expect(deliver.mock.calls[0][0].form).toStrictEqual({
			...storedForm,
			phoneNumber: "0001",
			addressLine3: "London",
		});
	});

	it("preserves a summer birth date at UTC midnight", async () => {
		await pool.query(
			"UPDATE transformed_forms SET date_of_birth = '1990-07-01' WHERE inbound_form_id = $1",
			[inboundFormId],
		);

		await deliverToFormBot(pool, inboundFormId, deliver);

		expect(deliver.mock.calls[0][0].form.dateOfBirth.toISOString()).toBe("1990-07-01T00:00:00.000Z");
	});

	it("throws a data-free error when SendGrid returns 500", async () => {
		send.mockResolvedValue({ statusCode: 500 });

		await expect(sendFormEmail(pool, inboundFormId, send)).rejects.toEqual(
			new Error("SendGrid returned 500"),
		);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("throws a data-free error when FORM-BOT returns 500", async () => {
		deliver.mockResolvedValue({ statusCode: 500 });

		await expect(deliverToFormBot(pool, inboundFormId, deliver)).rejects.toEqual(
			new Error("FORM-BOT returned 500"),
		);
		expect(deliver).toHaveBeenCalledTimes(1);
	});

	it("rejects a SendGrid redirect rather than treating it as success", async () => {
		send.mockResolvedValue({ statusCode: 302 });

		await expect(sendFormEmail(pool, inboundFormId, send)).rejects.toEqual(
			new Error("SendGrid returned 302"),
		);
	});

	it("rejects a FORM-BOT redirect rather than treating it as success", async () => {
		deliver.mockResolvedValue({ statusCode: 302 });

		await expect(deliverToFormBot(pool, inboundFormId, deliver)).rejects.toEqual(
			new Error("FORM-BOT returned 302"),
		);
	});

	it("does not send email when the transformed row is missing", async () => {
		await pool.query("DELETE FROM transformed_forms WHERE inbound_form_id = $1", [inboundFormId]);

		await expect(sendFormEmail(pool, inboundFormId, send)).rejects.toEqual(
			new Error("Transformed form not found"),
		);
		expect(send).not.toHaveBeenCalled();
	});

	it("does not call FORM-BOT when the transformed row is missing", async () => {
		await pool.query("DELETE FROM transformed_forms WHERE inbound_form_id = $1", [inboundFormId]);

		await expect(deliverToFormBot(pool, inboundFormId, deliver)).rejects.toEqual(
			new Error("Transformed form not found"),
		);
		expect(deliver).not.toHaveBeenCalled();
	});
});

describe("callProvider", () => {
	it("turns a provider that outlives its timeout into a JobError and cancels the request", async () => {
		let aborted = false;

		const call = callProvider(
			"SendGrid",
			(signal) => {
				signal.addEventListener("abort", () => {
					aborted = true;
				});
				return sleep(10_000, { statusCode: 200 }, { signal });
			},
			20,
		);

		await expect(call).rejects.toMatchObject({ message: "SendGrid timed out after 20ms" });
		expect(aborted).toBe(true);
	});
});
