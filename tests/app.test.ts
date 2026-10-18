import type { Pool } from "pg";
import request from "supertest";

import { createApp, INGEST_BODY_LIMIT } from "../src/app";
import { countRows, createCleanup, createMigratedPool } from "./helpers/db";

describe("POST /ingest HTTP errors", () => {
	const cleanup = createCleanup();
	let pool: Pool;

	beforeEach(async () => {
		pool = await createMigratedPool(cleanup);
	});

	afterEach(() => cleanup.run());

	const post = (contentType: string, body: string) =>
		request(createApp(pool)).post("/ingest").set("Content-Type", contentType).send(body);

	it("rejects malformed JSON with 400 and stores nothing", async () => {
		const response = await post("application/json", "{bad");

		expect(response.status).toBe(400);
		expect(response.body).toEqual({ error: "Request body must be valid JSON" });
		expect(await countRows(pool)).toEqual({ forms: 0, jobs: 0, tickets: 0 });
	});

	it("rejects an empty body with 400 and stores nothing", async () => {
		const response = await post("application/json", "");

		expect(response.status).toBe(400);
		expect(response.body).toEqual({ error: "Request body must be valid JSON" });
		expect(await countRows(pool)).toEqual({ forms: 0, jobs: 0, tickets: 0 });
	});

	it(`rejects a body over ${INGEST_BODY_LIMIT} with 413 and stores nothing`, async () => {
		const tooLarge = JSON.stringify({ padding: "a".repeat(100 * 1024) });

		const response = await post("application/json", tooLarge);

		expect(response.status).toBe(413);
		expect(response.body).toEqual({ error: `Request body must not exceed ${INGEST_BODY_LIMIT}` });
		expect(await countRows(pool)).toEqual({ forms: 0, jobs: 0, tickets: 0 });
	});

	it("rejects a non-JSON content type with 415 and stores nothing", async () => {
		const response = await post("text/plain", JSON.stringify({ application_reference: "REF-1" }));

		expect(response.status).toBe(415);
		expect(response.body).toEqual({ error: "Content-Type must be application/json" });
		expect(await countRows(pool)).toEqual({ forms: 0, jobs: 0, tickets: 0 });
	});
});
