import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { findTransformedForm } from "../src/db/transformed_forms";
import { processForm } from "../src/jobs/process_form";
import { JobError } from "../src/jobs/provider";
import type { lookupPostcode } from "../src/providers/idealpostcodes";
import type { FormStatus } from "../src/types";
import { coordinates, otherExamples, payloadWith, transformedWith } from "./fixtures/form";
import { countRows, createCleanup, createMigratedPool, ingestAndGetId } from "./helpers/db";

describe("processForm", () => {
	const cleanup = createCleanup();
	let pool: Pool;
	let geocode: jest.MockedFunction<typeof lookupPostcode>;

	beforeEach(async () => {
		pool = await createMigratedPool(cleanup);
		geocode = jest.fn().mockResolvedValue({ statusCode: 200, body: coordinates });
	});

	afterEach(async () => {
		await cleanup.run();
		jest.restoreAllMocks();
	});

	const snapshot = async () => {
		const forms = await pool.query("SELECT * FROM inbound_forms ORDER BY id");
		const jobs = await pool.query("SELECT * FROM jobs ORDER BY id");
		const tickets = await pool.query("SELECT * FROM dead_letters ORDER BY id");
		const transformed = await pool.query("SELECT * FROM transformed_forms ORDER BY inbound_form_id");

		return { forms: forms.rows, jobs: jobs.rows, tickets: tickets.rows, transformed: transformed.rows };
	};

	const formStatus = async (formId: string): Promise<FormStatus> => {
		const { rows } = await pool.query<{ status: FormStatus }>(
			"SELECT status FROM inbound_forms WHERE id = $1",
			[formId],
		);
		return rows[0].status;
	};

	const jobsOf = async (formId: string) => {
		const { rows } = await pool.query(
			"SELECT * FROM jobs WHERE inbound_form_id = $1 ORDER BY id",
			[formId],
		);
		return rows;
	};

	it("saves the transformed form with coordinates and queues one email and one FORM-BOT delivery", async () => {
		const formId = await ingestAndGetId(pool, payloadWith());
		const [processJob] = await jobsOf(formId);

		await processForm(pool, formId, geocode);
		const jobs = await jobsOf(formId);

		expect(await formStatus(formId)).toBe("transformed");
		expect(await findTransformedForm(pool, formId)).toStrictEqual({ ...transformedWith(), ...coordinates });
		expect(jobs.map(({ type, status, attempts }) => ({ type, status, attempts }))).toStrictEqual([
			{ type: "process_form", status: "pending", attempts: 0 },
			{ type: "send_email", status: "pending", attempts: 0 },
			{ type: "deliver_formbot", status: "pending", attempts: 0 },
		]);
		expect(jobs[0]).toStrictEqual(processJob);
		expect(geocode.mock.calls).toStrictEqual([["E15 4BZ", expect.any(AbortSignal)]]);
	});

	it("maps person_two with a middle name, other gender and no third address line", async () => {
		const formId = await ingestAndGetId(pool, otherExamples.personTwo);

		await processForm(pool, formId, geocode);

		expect(await findTransformedForm(pool, formId)).toStrictEqual({
			sessionId: "c77fb77f-5a95-4935-9d5a-12953f29da89",
			applicationReference: "GRU-123090-2026",
			firstName: "Andy James",
			lastName: "Smith-Jones",
			email: "andy.smith.jones@example.com",
			gender: "prefer-not-to-say",
			dateOfBirth: new Date("1985-06-20T00:00:00Z"),
			phoneNumber: "0001",
			mobileNumber: "07777777777",
			addressLine1: "1 The Avenue",
			addressLine2: "Bristol",
			addressLine3: undefined,
			postcode: "BS1 1AA",
			country: "United Kingdom",
			...coordinates,
		});
	});

	it("maps person_three with no phone number and no third address line", async () => {
		const formId = await ingestAndGetId(pool, otherExamples.personThree);

		await processForm(pool, formId, geocode);

		expect(await findTransformedForm(pool, formId)).toStrictEqual({
			sessionId: "881fa3b2-84cd-4517-b909-84a073ca0110",
			applicationReference: "GRU-123092-2026",
			firstName: "Jane",
			lastName: "Doe",
			email: "jane.doe@example.com",
			gender: "female",
			dateOfBirth: new Date("1921-03-14T00:00:00Z"),
			phoneNumber: undefined,
			mobileNumber: "07123456789",
			addressLine1: "123 Main St",
			addressLine2: "Apt 1",
			addressLine3: undefined,
			postcode: "SW1A 1AA",
			country: "United Kingdom",
			...coordinates,
		});
	});

	it("warns, without the coordinates, when the geocoder returns a location outside the UK and still processes the form", async () => {
		const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
		const outsideUk = { latitude: -5.05, longitude: 50.05 };
		geocode.mockResolvedValue({ statusCode: 200, body: outsideUk });
		const formId = await ingestAndGetId(pool, payloadWith());

		await processForm(pool, formId, geocode);

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(`Form ${formId}: geocoder returned coordinates outside the UK.`);
		expect(await formStatus(formId)).toBe("transformed");
		expect(await findTransformedForm(pool, formId)).toMatchObject(outsideUk);
		expect(await countRows(pool)).toEqual({ forms: 1, jobs: 3, tickets: 0 });
	});

	it("does not warn when the geocoder returns a location in the UK", async () => {
		const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
		const formId = await ingestAndGetId(pool, payloadWith());

		await processForm(pool, formId, geocode);

		expect(warn).not.toHaveBeenCalled();
		expect(await formStatus(formId)).toBe("transformed");
	});

	it("blocks a form that fails validation and opens one form ticket without geocoding", async () => {
		const formId = await ingestAndGetId(pool, payloadWith({ name: "John" }));
		const jobsBefore = await jobsOf(formId);

		await processForm(pool, formId, geocode);

		expect(await formStatus(formId)).toBe("blocked");
		expect((await pool.query("SELECT inbound_form_id, job_id, reason FROM dead_letters")).rows).toStrictEqual([{
			inbound_form_id: formId,
			job_id: null,
			reason: "Validation failed: name must have at least two words",
		}]);
		expect(await findTransformedForm(pool, formId)).toBeNull();
		expect(await jobsOf(formId)).toStrictEqual(jobsBefore);
		expect(geocode).not.toHaveBeenCalled();
	});

	it("throws a data-free error and writes nothing when the geocoder returns 500", async () => {
		const formId = await ingestAndGetId(pool, payloadWith());
		const before = await snapshot();
		geocode.mockResolvedValue({ statusCode: 500 });

		await expect(processForm(pool, formId, geocode)).rejects.toStrictEqual(
			new JobError("Geocoder returned 500"),
		);
		expect(await snapshot()).toStrictEqual(before);
		expect(await formStatus(formId)).toBe("received");
	});

	it("throws and writes nothing when the geocoder succeeds without coordinates", async () => {
		const formId = await ingestAndGetId(pool, payloadWith());
		const before = await snapshot();
		geocode.mockResolvedValue({ statusCode: 200 });

		await expect(processForm(pool, formId, geocode)).rejects.toStrictEqual(
			new JobError("Geocoder returned no coordinates"),
		);
		expect(await snapshot()).toStrictEqual(before);
	});

	it("throws and writes nothing when the geocoder returns a NaN latitude", async () => {
		const formId = await ingestAndGetId(pool, payloadWith());
		const before = await snapshot();
		geocode.mockResolvedValue({ statusCode: 200, body: { latitude: Number.NaN, longitude: -0.1 } });

		await expect(processForm(pool, formId, geocode)).rejects.toStrictEqual(
			new JobError("Geocoder returned invalid coordinates"),
		);
		expect(await snapshot()).toStrictEqual(before);
		expect(await formStatus(formId)).toBe("received");
		expect(await findTransformedForm(pool, formId)).toBeNull();
		expect((await jobsOf(formId)).map(({ type }) => type)).toStrictEqual(["process_form"]);
	});

	it("throws and writes nothing when the geocoder returns a latitude above 90", async () => {
		const formId = await ingestAndGetId(pool, payloadWith());
		const before = await snapshot();
		geocode.mockResolvedValue({ statusCode: 200, body: { latitude: 91, longitude: -0.1 } });

		await expect(processForm(pool, formId, geocode)).rejects.toStrictEqual(
			new JobError("Geocoder returned invalid coordinates"),
		);
		expect(await snapshot()).toStrictEqual(before);
		expect(await formStatus(formId)).toBe("received");
		expect(await findTransformedForm(pool, formId)).toBeNull();
		expect((await jobsOf(formId)).map(({ type }) => type)).toStrictEqual(["process_form"]);
	});

	it("throws and writes nothing when the geocoder returns a longitude below -180", async () => {
		const formId = await ingestAndGetId(pool, payloadWith());
		const before = await snapshot();
		geocode.mockResolvedValue({ statusCode: 200, body: { latitude: 51.5, longitude: -181 } });

		await expect(processForm(pool, formId, geocode)).rejects.toStrictEqual(
			new JobError("Geocoder returned invalid coordinates"),
		);
		expect(await snapshot()).toStrictEqual(before);
		expect(await formStatus(formId)).toBe("received");
		expect(await findTransformedForm(pool, formId)).toBeNull();
		expect((await jobsOf(formId)).map(({ type }) => type)).toStrictEqual(["process_form"]);
	});

	it("does nothing when re-run after the form was transformed", async () => {
		const formId = await ingestAndGetId(pool, payloadWith());
		await processForm(pool, formId, geocode);
		const before = await snapshot();

		await processForm(pool, formId, geocode);

		expect(await snapshot()).toStrictEqual(before);
		expect(geocode).toHaveBeenCalledTimes(1);
	});

	it("does nothing when re-run after the form was blocked", async () => {
		const formId = await ingestAndGetId(pool, payloadWith({ name: "John" }));
		await processForm(pool, formId, geocode);
		const before = await snapshot();

		await processForm(pool, formId, geocode);

		expect(await snapshot()).toStrictEqual(before);
		expect((await countRows(pool)).tickets).toBe(1);
		expect(geocode).not.toHaveBeenCalled();
	});

	it("throws when the inbound form does not exist", async () => {
		await expect(processForm(pool, randomUUID(), geocode)).rejects.toStrictEqual(
			new JobError("Inbound form not found"),
		);
		expect(geocode).not.toHaveBeenCalled();
	});

	it("rolls back the status change and delivery jobs when the transformed insert fails", async () => {
		const formId = await ingestAndGetId(pool, payloadWith());
		await pool.query(
			`INSERT INTO transformed_forms (
				inbound_form_id, application_reference, session_id, first_name, last_name,
				email, gender, date_of_birth, mobile_number, address_line_1, address_line_2,
				postcode, country, latitude, longitude
			) VALUES ($1, 'GRU-STALE', 'stale-session', 'Stale', 'Row', 'stale@example.com', 'female',
				'2000-02-02', '07000000000', 'Old Line 1', 'Old Line 2', 'N1 1AA', 'United Kingdom', 1, 2)`,
			[formId],
		);
		const before = await snapshot();

		await expect(processForm(pool, formId, geocode)).rejects.toMatchObject({
			code: "23505",
			constraint: "transformed_forms_pkey",
		});
		expect(await snapshot()).toStrictEqual(before);
		expect(await formStatus(formId)).toBe("received");
		expect((await jobsOf(formId)).map(({ type }) => type)).toStrictEqual(["process_form"]);
	});
});
