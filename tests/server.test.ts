import http, { get, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { Pool } from "pg";

import { createApp } from "../src/app";
import { startService } from "../src/server";
import type { Worker } from "../src/worker/types";
import { startWorker } from "../src/worker/worker";

jest.mock("../src/app", () => ({ createApp: jest.fn() }));
jest.mock("../src/worker/worker", () => ({ startWorker: jest.fn() }));

const createAppMock = jest.mocked(createApp);
const startWorkerMock = jest.mocked(startWorker);

const deferred = <T = void>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

describe("startService", () => {
	let createServerSpy: jest.SpiedFunction<typeof http.createServer>;
	let services: Array<ReturnType<typeof startService>>;
	let events: string[];
	let pool: Pool & { end: jest.Mock };
	let workerDone: ReturnType<typeof deferred<void>>;
	let worker: Worker & { stop: jest.Mock };
	let release: ReturnType<typeof deferred<void>>;
	let requestArrived: ReturnType<typeof deferred<void>>;
	let acquire: ReturnType<typeof deferred<void>>;

	beforeEach(async () => {
		jest.spyOn(console, "log").mockImplementation(() => undefined);
		jest.spyOn(console, "error").mockImplementation(() => undefined);
		createServerSpy = jest.spyOn(http, "createServer");
		services = [];
		events = [];
		pool = {
			options: { connectionString: "postgres://test" },
			end: jest.fn(async () => {
				events.push("pool ended");
			}),
		} as unknown as Pool & { end: jest.Mock };
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
			await Promise.all(services.map((service) => service.shutdown()));
		} finally {
			jest.clearAllMocks();
			jest.restoreAllMocks();
		}
	});

	const start = (port: number = 0) => {
		const service = startService({ pool, port });
		services.push(service);
		return service;
	};

	const started = async () => {
		for (let i = 0; i < 200 && startWorkerMock.mock.calls.length === 0; i++) {
			await sleep(5);
		}
		if (startWorkerMock.mock.calls.length === 0) {
			throw new Error("Worker startup was not reached");
		}
		await sleep(5);
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

	it("starts the worker with the shared pool, its connection string and the three handlers", async () => {
		const service = start();
		await started();

		expect(createAppMock).toHaveBeenCalledWith(pool);
		expect(startWorkerMock.mock.calls).toStrictEqual([
			[
				{
					pool,
					connectionString: "postgres://test",
					handlers: {
						process_form: expect.any(Function),
						send_email: expect.any(Function),
						deliver_formbot: expect.any(Function),
					},
				},
			],
		]);

		const closed = service.shutdown();
		workerDone.resolve();
		expect(await closed).toBe(0);
	});

	it("waits for an in-flight request before ending the pool", async () => {
		const service = start();
		await started();
		const response = request();
		await requestArrived.promise;

		const closed = service.shutdown();
		workerDone.resolve();
		await sleep(50);
		expect(worker.stop).toHaveBeenCalledTimes(1);
		expect(pool.end).not.toHaveBeenCalled();

		release.resolve();
		expect(await response).toBe("done");
		expect(await closed).toBe(0);
		expect(events).toStrictEqual(["worker stopped", "response sent", "pool ended"]);
	});

	it("waits for the worker's active job before ending the pool", async () => {
		const service = start();
		await started();
		const response = request();
		await requestArrived.promise;

		const closed = service.shutdown();
		release.resolve();
		expect(await response).toBe("done");
		await sleep(50);
		expect(pool.end).not.toHaveBeenCalled();

		workerDone.resolve();
		expect(await closed).toBe(0);
		expect(events).toStrictEqual(["response sent", "worker stopped", "pool ended"]);
	});

	it("reuses one shutdown for repeated requests", async () => {
		const service = start();
		await started();

		const first = service.shutdown();
		const second = service.shutdown();
		workerDone.resolve();

		expect(second).toBe(first);
		expect(await first).toBe(0);
		expect(await service.shutdown()).toBe(0);
		expect(worker.stop).toHaveBeenCalledTimes(1);
		expect(pool.end).toHaveBeenCalledTimes(1);
	});

	it("closes the server and ends the pool when worker startup throws", async () => {
		startWorkerMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

		const service = start();

		expect(await service.shutdownComplete).toBe(1);
		expect(console.error).toHaveBeenCalledWith("Startup failed: connect ECONNREFUSED");
		expect(pool.end).toHaveBeenCalledTimes(1);
		expect(server().listening).toBe(false);
	});

	it("does not start the worker and ends the pool when the port is in use", async () => {
		const occupied = http.createServer();
		await new Promise<void>((resolve) => occupied.listen(0, resolve));

		try {
			const service = start((occupied.address() as AddressInfo).port);

			expect(await service.shutdownComplete).toBe(1);
			expect(console.error).toHaveBeenCalledWith(expect.stringContaining("EADDRINUSE"));
			expect(startWorkerMock).not.toHaveBeenCalled();
			expect(pool.end).toHaveBeenCalledTimes(1);
		} finally {
			await new Promise((resolve) => occupied.close(resolve));
		}
	});

	it("stops a worker acquired after shutdown was requested during startup", async () => {
		startWorkerMock.mockReturnValue(acquire.promise.then(() => worker));

		const service = start();
		await started();
		const closed = service.shutdown();

		workerDone.resolve();
		acquire.resolve();

		expect(await closed).toBe(0);
		expect(worker.stop).toHaveBeenCalledTimes(1);
		expect(pool.end).toHaveBeenCalledTimes(1);
		expect(server().listening).toBe(false);
	});

	it("keeps the API running when another worker holds the lock", async () => {
		startWorkerMock.mockResolvedValue(null);

		const service = start();
		await started();
		release.resolve();

		expect(await request()).toBe("done");
		expect(await service.shutdown()).toBe(0);
		expect(pool.end).toHaveBeenCalledTimes(1);
	});

	it("cleans up with exit code 1 when the worker stops unexpectedly and keeps it after a signal", async () => {
		const service = start();
		await started();

		workerDone.resolve();

		expect(await service.shutdownComplete).toBe(1);
		expect(console.error).toHaveBeenCalledWith("Worker stopped unexpectedly");
		expect(pool.end).toHaveBeenCalledTimes(1);
		expect(await service.shutdown()).toBe(1);
		expect(pool.end).toHaveBeenCalledTimes(1);
	});

	it("still ends the pool and exits 1 when stopping the worker fails", async () => {
		const service = start();
		await started();
		worker.stop.mockRejectedValue(new Error("lock release failed"));

		expect(await service.shutdown()).toBe(1);
		expect(console.error).toHaveBeenCalledWith("Shutdown cleanup failed:", "lock release failed");
		expect(pool.end).toHaveBeenCalledTimes(1);
	});
});
