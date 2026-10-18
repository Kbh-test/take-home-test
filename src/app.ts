import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import type { Pool } from "pg";

import { ingestForm } from "./ingest/ingest";

export const INGEST_BODY_LIMIT = "100kb";

const requireJson: RequestHandler = (req, res, next) => {
	if (!req.is("application/json")) {
		res.status(415).json({ error: "Content-Type must be application/json" });
		return;
	}

	next();
};

const handleBodyErrors: ErrorRequestHandler = (error, _req, res, next) => {
	if (error.type === "entity.parse.failed") {
		res.status(400).json({ error: "Request body must be valid JSON" });
		return;
	}

	if (error.type === "entity.too.large") {
		res.status(413).json({ error: `Request body must not exceed ${INGEST_BODY_LIMIT}` });
		return;
	}

	next(error);
};

export function createApp(pool: Pool) {
	const app = express();

	app.post(
		"/ingest",
		requireJson,
		express.json({
			limit: INGEST_BODY_LIMIT,
			strict: false,
			// Express treats an empty body as {}; reject it before parsing.
			verify: (_req, _res, body) => {
				if (body.length === 0) {
					throw Object.assign(new Error("Empty body"), { type: "entity.parse.failed" });
				}
			},
		}),
		async (req, res) => {
			try {
				await ingestForm(pool, req.body);
				res.status(202).json({ status: "accepted" });
			} catch (error) {
				console.error("Ingest failed:", (error as Error).message);
				res.status(503).json({ error: "Service unavailable, retry later" });
			}
		},
	);

	app.use(handleBodyErrors);

	return app;
}
