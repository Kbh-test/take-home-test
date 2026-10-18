const requiredFields = [
	"session_id",
	"application_reference",
	"name",
	"email",
	"gender",
	"date_of_birth",
	"mobile_number",
	"address.address_line_1",
	"address.address_line_2",
	"address.postcode",
	"address.country",
] as const;

export function missingFields(payload: unknown): string[] {
	return requiredFields.filter((path) => {
		let value: unknown = payload;

		for (const key of path.split(".")) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return true;
			}

			value = Object.hasOwn(value, key)
				? (value as Record<string, unknown>)[key]
				: undefined;
		}

		return value == null || (typeof value === "string" && value.trim() === "");
	});
}
