import type { Pool } from "pg";

import { deliverToFormBot } from "../../src/jobs/deliver_formbot";
import { processForm } from "../../src/jobs/process_form";
import { sendFormEmail } from "../../src/jobs/send_email";
import type { deliverForm } from "../../src/providers/formbot";
import type { lookupPostcode } from "../../src/providers/idealpostcodes";
import type { sendEmail } from "../../src/providers/sendgrid";
import type { Worker } from "../../src/worker/types";
import { startWorker } from "../../src/worker/worker";
import { coordinates } from "../fixtures/form";
import type { Cleanup } from "./db";

type FakeProviders = {
	geocode: jest.MockedFunction<typeof lookupPostcode>;
	send: jest.MockedFunction<typeof sendEmail>;
	deliver: jest.MockedFunction<typeof deliverForm>;
};

export function fakeProviders(): FakeProviders {
	return {
		geocode: jest.fn().mockResolvedValue({ statusCode: 200, body: coordinates }),
		send: jest.fn().mockResolvedValue({ statusCode: 202 }),
		deliver: jest.fn().mockResolvedValue({ statusCode: 204 }),
	};
}

export async function startPipelineWorker(
	pool: Pool,
	cleanup: Cleanup,
	providers: FakeProviders,
): Promise<Worker> {
	const worker = await startWorker({
		pool,
		connectionString: pool.options.connectionString!,
		handlers: {
			process_form: (p, formId) => processForm(p, formId, providers.geocode),
			send_email: (p, formId) => sendFormEmail(p, formId, providers.send),
			deliver_formbot: (p, formId) => deliverToFormBot(p, formId, providers.deliver),
		},
		pollIntervalMs: 10,
		retryDelayMs: () => 0,
	});

	expect(worker).not.toBeNull();
	return cleanup.track(worker!, (w) => w.stop());
}
