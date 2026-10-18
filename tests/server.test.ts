import { once } from "node:events";
import http, { get, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";

import { createApp } from "../src/app";
import { startService } from "../src/server";
import type { Service } from "../src/types";
import type { Worker } from "../src/worker/types";
import { startWorker } from "../src/worker/worker";
import { type Deferred, deferred, nextTurn } from "./helpers/async";

jest.mock("../src/app", () => ({ createApp: jest.fn() }));
jest.mock("../src/worker/worker", () => ({ startWorker: jest.fn() }));

const createAppMock = jest.mocked(createApp);
const startWorkerMock = jest.mocked(startWorker);

const CONNECTION_STRING = "postgres://test";

describe("startService", () => {
	let createServerSpy: jest.SpiedFunction<typeof http.createServer>;
	let services: Service[];
	let events: string[];
	let pool: Pool & { end: jest.Mock };
	let workerDone: Deferred;
	let worker: Worker & { stop: jest.Mock };
	let release: Deferred;
	let requestArrived: Deferred;
	let acquire: Deferred;

	beforeEach(() => {
		jest.spyOn(console, "log").mockImplementation(() => undefined);
		jest.spyOn(console, "error").mockImplementation(() => undefined);
		createServerSpy = jest.spyOn(http, "createServer");
		services = [];
		events = [];
		pool = { end: jest.fn() } as unknown as Pool & { end: jest.Mock };
		workerDone = deferred();
		worker = {
			stopped: workerDone.promise.then(() => {
				events.push("worker stopped");
			}),
			stop: jest.fn(() => worker.stopped),
		};
		release = deferred();
		requestArrived = deferred();
		acquire = deferred();
		const app: RequestListener = (_req, res) => {
			requestArrived.resolve();
			void release.promise.then(() => {
				res.end("done");
				events.push("response sent");
			});
		};
		createAppMock.mockReturnValue(app as ReturnType<typeof createApp>);
		startWorkerMock.mockResolvedValue(worker);
	});

	afterEach(async () => {
		release.resolve();
		workerDone.resolve();
		acquire.resolve();

		try {
			await Promise.allSettled(services.map((service) => service.stop()));
		} finally {
			jest.clearAllMocks();
			jest.restoreAllMocks();
		}
	});

	const start = (port: number = 0) => {
		const service = startService({ pool, connectionString: CONNECTION_STRING, port });
		services.push(service);
		return service;
	};

	const server = (): Server => createServerSpy.mock.results.at(-1)!.value;

	const request = () =>
		new Promise<string>((resolve, reject) => {
			const { port } = server().address() as AddressInfo;
			get({ port, host: "127.0.0.1", agent: false }, (res) => {
				let body = "";
				res.on("data", (chunk) => (body += chunk));
				res.on("end", () => resolve(body));
			}).on("error", reject);
		});

	const markStopped = (service: Service) =>
		service.stop().then(() => {
			events.push("service stopped");
		});

	it("starts the worker with the shared pool, its connection string and the three handlers", async () => {
		const service = start();
		await service.ready;

		expect(createAppMock).toHaveBeenCalledWith(pool);
		expect(startWorkerMock.mock.calls).toStrictEqual([
			[
				{
					pool,
					connectionString: CONNECTION_STRING,
					handlers: {
						process_form: expect.any(Function),
						send_email: expect.any(Function),
						deliver_formbot: expect.any(Function),
					},
				},
			],
		]);

		workerDone.resolve();
		await service.stop();
		expect(pool.end).not.toHaveBeenCalled();
	});

	it("finishes an in-flight request before stop resolves", async () => {
		const service = start();
		await service.ready;
		const response = request();
		await requestArrived.promise;

		const stopped = markStopped(service);
		workerDone.resolve();
		await worker.stopped;
		await nextTurn();
		expect(events).toStrictEqual(["worker stopped"]);

		release.resolve();
		expect(await response).toBe("done");
		await stopped;
		expect(events).toStrictEqual(["worker stopped", "response sent", "service stopped"]);
	});

	it("finishes the worker's active job before stop resolves", async () => {
		const service = start();
		await service.ready;
		const response = request();
		await requestArrived.promise;

		const closed = once(server(), "close");
		const stopped = markStopped(service);
		release.resolve();
		expect(await response).toBe("done");
		await closed;
		await nextTurn();
		expect(events).toStrictEqual(["response sent"]);

		workerDone.resolve();
		await stopped;
		expect(events).toStrictEqual(["response sent", "worker stopped", "service stopped"]);
	});

	it("asks the worker to stop while a request is still in flight", async () => {
		const service = start();
		await service.ready;
		const response = request();
		await requestArrived.promise;

		const stopped = service.stop();
		await nextTurn();
		expect(worker.stop).toHaveBeenCalledTimes(1);
		expect(server().listening).toBe(false);
		expect(events).toStrictEqual([]);

		release.resolve();
		workerDone.resolve();
		expect(await response).toBe("done");
		await stopped;
	});

	it("reuses one stop promise for repeated calls", async () => {
		const service = start();
		await service.ready;

		const first = service.stop();
		const second = service.stop();
		workerDone.resolve();

		expect(second).toBe(first);
		await first;
		expect(service.stop()).toBe(first);
		expect(worker.stop).toHaveBeenCalledTimes(1);
	});

	it("rejects ready and closes the server when worker startup throws", async () => {
		startWorkerMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

		const service = start();

		await expect(service.ready).rejects.toThrow("connect ECONNREFUSED");
		await service.stop();
		expect(server().listening).toBe(false);
	});

	it("rejects ready and does not start the worker when the port is in use", async () => {
		const occupied = http.createServer();
		await new Promise<void>((resolve) => occupied.listen(0, resolve));

		try {
			const service = start((occupied.address() as AddressInfo).port);

			await expect(service.ready).rejects.toThrow("EADDRINUSE");
			await service.stop();
			expect(startWorkerMock).not.toHaveBeenCalled();
		} finally {
			await new Promise((resolve) => occupied.close(resolve));
		}
	});

	it("skips worker startup when stop is requested before the server is listening", async () => {
		const service = start();
		const stopped = service.stop();

		await service.ready;
		await stopped;
		expect(startWorkerMock).not.toHaveBeenCalled();
		expect(server().listening).toBe(false);
	});

	it("stops a worker acquired after stop was requested during startup", async () => {
		const workerRequested = deferred();
		startWorkerMock.mockImplementation(() => {
			workerRequested.resolve();
			return acquire.promise.then(() => worker);
		});

		const service = start();
		await workerRequested.promise;
		const stopped = service.stop();
		await nextTurn();
		expect(worker.stop).not.toHaveBeenCalled();

		acquire.resolve();
		workerDone.resolve();
		await service.ready;
		await stopped;
		expect(worker.stop).toHaveBeenCalledTimes(1);
		expect(server().listening).toBe(false);
	});

	it("keeps the API running when another worker holds the lock", async () => {
		startWorkerMock.mockResolvedValue(null);

		const service = start();
		await service.ready;
		release.resolve();

		expect(await request()).toBe("done");
		await service.stop();
	});

	it("resolves workerStopped when the worker loop ends", async () => {
		const service = start();
		await service.ready;

		workerDone.resolve();

		await service.workerStopped;
		expect(events).toStrictEqual(["worker stopped"]);
	});

	it("resolves workerStopped and reports the loop error from stop when the worker loop rejects", async () => {
		const service = start();
		await service.ready;

		workerDone.reject(new Error("loop crashed"));
		await service.workerStopped;

		const failure = await service.stop().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toStrictEqual([new Error("loop crashed")]);
		expect(server().listening).toBe(false);
	});

	it("still stops the worker and reports the failure when closing the server fails", async () => {
		const service = start();
		await service.ready;
		const closeServer = server().close.bind(server());
		jest
			.spyOn(server(), "close")
			.mockImplementation((callback) => closeServer(() => callback?.(new Error("close failed"))));
		workerDone.resolve();

		const failure = await service.stop().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toStrictEqual([new Error("close failed")]);
		expect(worker.stop).toHaveBeenCalledTimes(1);
		expect(events).toStrictEqual(["worker stopped"]);
	});

	it("still closes the server and reports the failure when stopping the worker fails", async () => {
		const service = start();
		await service.ready;
		worker.stop.mockRejectedValue(new Error("lock release failed"));

		const failure = await service.stop().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toStrictEqual([new Error("lock release failed")]);
		expect(server().listening).toBe(false);
	});
});
