import { type } from "arktype";

export const DEFAULT_ATTEMPT_LIMIT = 5;

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isCalendarDate = (value: string): boolean => {
	if (!CALENDAR_DATE_PATTERN.test(value)) {
		return false;
	}

	const [year, month, day] = value.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));

	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	);
};

export const calendarDate = type("string").narrow(
	(value, ctx) =>
		isCalendarDate(value) ||
		ctx.mustBe("a real date in YYYY-MM-DD format"),
);

export const calendarDateToUtc = (value: string): Date =>
	new Date(`${value}T00:00:00Z`);

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function readPort(value = "3000"): number {
	const port = Number(value);

	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("PORT must be an integer between 1 and 65535");
	}

	return port;
}

export function readAttemptLimit(name: string, value = String(DEFAULT_ATTEMPT_LIMIT)): number {
	const limit = Number(value);

	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new Error(`${name} must be a positive safe integer`);
	}

	return limit;
}
