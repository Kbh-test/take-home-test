import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import type { Pool } from "pg";

import { errorMessage } from "./helpers";
import { HTTP_ERRORS, INGEST_BODY_LIMIT, sendError } from "./http_errors";
import { ingestForm } from "./ingest/ingest";

const requireJson: RequestHandler = (req, res, next) => {
	if (!req.is("application/json")) {
		sendError(res, HTTP_ERRORS.unsupportedMediaType);
		return;
	}

	next();
};

const handleBodyErrors: ErrorRequestHandler = (error, _req, res, next) => {
	if (error.type === "entity.parse.failed") {
		sendError(res, HTTP_ERRORS.malformedJson);
		return;
	}

	if (error.type === "entity.too.large") {
		sendError(res, HTTP_ERRORS.tooLarge);
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
				console.error("Ingest failed:", errorMessage(error));
				sendError(res, HTTP_ERRORS.unavailable);
			}
		},
	);

	app.use(handleBodyErrors);

	return app;
}
