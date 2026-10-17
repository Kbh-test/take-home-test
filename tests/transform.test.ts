import { transform } from "../src/forms/transform";
import { otherExamples, payloadWith, transformedWith } from "./fixtures/form";

const mapped = (payload: unknown) => {
	const result = transform(payload);
	if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
	return result.form;
};

const blockedReason = (payload: unknown) => {
	const result = transform(payload);
	if (result.ok) throw new Error("expected blocked, got ok");
	return result.reason;
};

describe("transform() maps", () => {
	it("person_one field by field", () => {
		expect(mapped(payloadWith())).toEqual(transformedWith());
	});

	it("person_two (phone 0001, no address_line_3)", () => {
		expect(transform(otherExamples.personTwo).ok).toBe(true);
	});

	it("person_three (no phone_number, no address_line_3)", () => {
		expect(transform(otherExamples.personThree).ok).toBe(true);
	});

	it("a multi-word name: last word is lastName, the rest is firstName", () => {
		expect(mapped(payloadWith({ name: "Andy James Smith-Jones" }))).toEqual(
			transformedWith({ firstName: "Andy James", lastName: "Smith-Jones" }),
		);
	});

	it("gender other to prefer-not-to-say", () => {
		expect(mapped(payloadWith({ gender: "other" }))).toEqual(transformedWith({ gender: "prefer-not-to-say" }));
	});
});

describe("transform() blocks", () => {
	it("a renamed required field (email -> work_email)", () => {
		const { email, ...payload } = payloadWith();
		expect(blockedReason({ ...payload, work_email: email })).toBe("email is missing");
	});

	it("an unknown gender", () => {
		expect(blockedReason(payloadWith({ gender: "prefer_not_to_say" }))).toBe("gender is invalid");
	});

	it.each(["13/01/1990", "1990-02-30"])("a date of birth that is not a real date: %p", (dateOfBirth) => {
		expect(blockedReason(payloadWith({ date_of_birth: dateOfBirth }))).toBe("date_of_birth is invalid");
	});

	it("a one-word name", () => {
		expect(blockedReason(payloadWith({ name: "Jane" }))).toBe("name must have at least two words");
	});

	it("without echoing submitted values in the reason", () => {
		expect(blockedReason(payloadWith({ gender: "secret-value" }))).not.toMatch(/secret/);
	});
});
