import { readAttemptLimit } from "../src/helpers";

describe("attempt limit configuration", () => {
	it("defaults both limits to five", () => {
		expect(readAttemptLimit("PROCESS_FORM_MAX_ATTEMPTS")).toBe(5);
		expect(readAttemptLimit("SEND_EMAIL_MAX_ATTEMPTS")).toBe(5);
	});

	it("accepts positive integer limits", () => {
		expect(readAttemptLimit("PROCESS_FORM_MAX_ATTEMPTS", "1")).toBe(1);
		expect(readAttemptLimit("SEND_EMAIL_MAX_ATTEMPTS", "7")).toBe(7);
	});

	it("rejects invalid values with the environment variable name", () => {
		for (const name of ["PROCESS_FORM_MAX_ATTEMPTS", "SEND_EMAIL_MAX_ATTEMPTS"]) {
			for (const value of ["", " ", "0", "-1", "1.5", "no", "NaN", "Infinity", "9007199254740992"]) {
				expect(() => readAttemptLimit(name, value)).toThrow(`${name} must be a positive safe integer`);
			}
		}
	});
});
