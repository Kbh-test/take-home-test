import { EventEmitter } from "node:events";
import type { Pool } from "pg";

import { run } from "../src/run";
import type { Service, ServiceOptions } from "../src/types";
import { type Deferred, deferred, nextTurn } from "./helpers/async";

const CONNECTION_STRING = "postgres://test";

describe("run", () => {
	let events: string[];
	let signals: EventEmitter;
	let pool: Pool & { end: jest.Mock };
	let ready: Deferred;
	let stopped: Deferred;
	let workerStopped: Deferred;
	let exited: Deferred<number>;
	let exit: jest.Mock<void, [number]>;
	let start: jest.Mock<Service, [ServiceOptions]>;

	beforeEach(() => {
		events = [];
		jest.spyOn(console, "log").mockImplementation(() => undefined);
		jest.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			events.push(args.join(" "));
		});
		signals = new EventEmitter();
		pool = {
			end: jest.fn(async () => {
				events.push("pool end");
			}),
		} as unknown as Pool & { end: jest.Mock };
		ready = deferred();
		stopped = deferred();
		workerStopped = deferred();
		exited = deferred<number>();
		exit = jest.fn((code: number) => {
			events.push(`exit ${code}`);
			exited.resolve(code);
		});
		start = jest.fn((_options: ServiceOptions): Service => ({
			ready: ready.promise,
			workerStopped: workerStopped.promise,
			stop: () => {
				events.push("stop");
				return stopped.promise;
			},
		}));
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	const launch = () => run({ pool, connectionString: CONNECTION_STRING, port: 0, exit, signals, start });

	it("stops the service, ends the pool and exits 0 on the first signal", async () => {
		launch();
		signals.emit("SIGINT");

		expect(start).toHaveBeenCalledWith({ pool, connectionString: CONNECTION_STRING, port: 0 });
		expect(events).toStrictEqual(["stop"]);

		stopped.resolve();

		expect(await exited.promise).toBe(0);
		expect(events).toStrictEqual(["stop", "pool end", "exit 0"]);
		expect(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM")).toBe(0);
	});

	it("forces exit 1 on a second signal while cleanup is pending", () => {
		launch();
		signals.emit("SIGINT");
		signals.emit("SIGTERM");

		expect(exit.mock.calls).toStrictEqual([[1]]);
		expect(events).toStrictEqual(["stop", "Forced exit", "exit 1"]);
		expect(pool.end).not.toHaveBeenCalled();
	});

	it("logs a startup failure, cleans up and exits 1", async () => {
		stopped.resolve();
		launch();
		ready.reject(new Error("listen EADDRINUSE"));

		expect(await exited.promise).toBe(1);
		expect(events).toStrictEqual(["Startup failed: listen EADDRINUSE", "stop", "pool end", "exit 1"]);
	});

	it("logs a synchronous startup error, ends the pool and exits 1", async () => {
		start.mockImplementation(() => {
			throw new RangeError("Port should be >= 0 and < 65536. Received type number (-1).");
		});

		launch();

		expect(await exited.promise).toBe(1);
		expect(events).toStrictEqual([
			"Startup failed: Port should be >= 0 and < 65536. Received type number (-1).",
			"pool end",
			"exit 1",
		]);
		expect(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM")).toBe(0);
	});

	it("logs an unexpected worker stop, cleans up and exits 1", async () => {
		stopped.resolve();
		launch();
		workerStopped.resolve();

		expect(await exited.promise).toBe(1);
		expect(events).toStrictEqual(["Worker stopped unexpectedly", "stop", "pool end", "exit 1"]);
	});

	it("exits 1 and logs the worker loop error when the worker fails", async () => {
		launch();
		workerStopped.resolve();
		stopped.reject(new AggregateError([new Error("loop crashed")], "Service stop failed"));

		expect(await exited.promise).toBe(1);
		expect(events).toStrictEqual([
			"Worker stopped unexpectedly",
			"stop",
			"Shutdown cleanup failed: loop crashed",
			"pool end",
			"exit 1",
		]);
	});

	it("still ends the pool and exits 1 when stopping the service fails", async () => {
		launch();
		signals.emit("SIGTERM");
		stopped.reject(new AggregateError([new Error("lock release failed")], "Service stop failed"));

		expect(await exited.promise).toBe(1);
		expect(events).toStrictEqual(["stop", "Shutdown cleanup failed: lock release failed", "pool end", "exit 1"]);
	});

	it("exits 1 when ending the pool fails", async () => {
		pool.end.mockRejectedValue(new Error("pool already ended"));
		launch();
		signals.emit("SIGINT");
		stopped.resolve();

		expect(await exited.promise).toBe(1);
		expect(events).toStrictEqual(["stop", "Shutdown cleanup failed: pool already ended", "exit 1"]);
	});

	it("raises the exit code without exiting early when startup fails after a signal", async () => {
		launch();
		signals.emit("SIGINT");
		ready.reject(new Error("connect ECONNREFUSED"));
		await nextTurn();

		expect(exit).not.toHaveBeenCalled();

		stopped.resolve();

		expect(await exited.promise).toBe(1);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(events).toStrictEqual(["stop", "Startup failed: connect ECONNREFUSED", "pool end", "exit 1"]);
	});

	it("does not report a worker stopped by its own shutdown as unexpected", async () => {
		launch();
		signals.emit("SIGINT");
		workerStopped.resolve();
		stopped.resolve();

		expect(await exited.promise).toBe(0);
		expect(events).toStrictEqual(["stop", "pool end", "exit 0"]);
	});

	it("does not count a failure as a signal", async () => {
		launch();
		workerStopped.resolve();
		await nextTurn();
		signals.emit("SIGINT");

		expect(exit).not.toHaveBeenCalled();

		stopped.resolve();

		expect(await exited.promise).toBe(1);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(events).toStrictEqual(["Worker stopped unexpectedly", "stop", "pool end", "exit 1"]);
	});
});
