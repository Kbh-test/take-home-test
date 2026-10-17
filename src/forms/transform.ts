import { type } from "arktype";

import { calendarDateToUtc } from "../helpers";
import {
	IngestedForm,
	type Gender,
	type IngestedGender,
	type TransformResult,
} from "../types";

const GENDER_MAP = {
	male: "male",
	female: "female",
	other: "prefer-not-to-say",
} satisfies Record<IngestedGender, Gender>;

const validationErrorReason = (
	errors: InstanceType<typeof type.errors>,
): string =>
	errors
		.map((error) => {
			const field = error.propString || "payload";

			return error.code === "required"
				? `${field} is missing`
				: `${field} is invalid`;
		})
		.join("; ");

type ParsedName = {
	firstName: string;
	lastName: string;
};

const parseName = (name: string): ParsedName | undefined => {
	const parts = name.trim().split(/\s+/);

	if (parts.length < 2) {
		return undefined;
	}

	const lastName = parts.pop()!;

	return {
		firstName: parts.join(" "),
		lastName,
	};
};

export function transform(payload: unknown): TransformResult {
	const input = IngestedForm(payload);

	if (input instanceof type.errors) {
		return {
			ok: false,
			reason: validationErrorReason(input),
		};
	}

	const name = parseName(input.name);

	if (!name) {
		return {
			ok: false,
			reason: "name must have at least two words",
		};
	}

	return {
		ok: true,
		form: {
			sessionId: input.session_id,
			applicationReference: input.application_reference,
			firstName: name.firstName,
			lastName: name.lastName,
			email: input.email,
			gender: GENDER_MAP[input.gender],
			dateOfBirth: calendarDateToUtc(input.date_of_birth),
			phoneNumber: input.phone_number,
			mobileNumber: input.mobile_number,
			addressLine1: input.address.address_line_1,
			addressLine2: input.address.address_line_2,
			addressLine3: input.address.address_line_3,
			postcode: input.address.postcode,
			country: input.address.country,
		},
	};
}