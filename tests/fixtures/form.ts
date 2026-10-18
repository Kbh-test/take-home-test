import type { MappedForm } from "../../src/types";
import personOne from "../../src/forms/examples/person_one.json";
import personTwo from "../../src/forms/examples/person_two.json";
import personThree from "../../src/forms/examples/person_three.json";

type Payload = Record<string, any>;

const transformed: MappedForm = {
	sessionId: "c8267b77-d796-451e-9948-e82f56412b56",
	applicationReference: "GRU-123089-2026",
	firstName: "John",
	lastName: "Doe",
	email: "john.doe@example.com",
	gender: "male",
	dateOfBirth: new Date("1990-01-01T00:00:00Z"),
	phoneNumber: "07123456789",
	mobileNumber: "07123456789",
	addressLine1: "Stratford Village Surgery",
	addressLine2: "50C Romford Road",
	addressLine3: "London",
	postcode: "E15 4BZ",
	country: "United Kingdom",
};

export const coordinates = { latitude: -5.05, longitude: 50.05 };

export const payloadWith = (overrides: Payload = {}): Payload => ({ ...structuredClone(personOne), ...overrides });

export const transformedWith = (overrides: Partial<MappedForm> = {}): MappedForm => ({ ...transformed, ...overrides });

export const otherExamples = { personTwo, personThree };
