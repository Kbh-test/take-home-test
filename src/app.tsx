import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { renderToString } from "react-dom/server";

import { requeueTicket } from "./cli/commands";
import { listRecentJobs, listRecentRequests } from "./db/requests";
import { errorMessage } from "./helpers";
import { HTTP_ERRORS, INGEST_BODY_LIMIT, sendError } from "./http_errors";
import { ingestForm } from "./ingest/ingest";
import { HomePage } from "./pages/HomePage";
import { WorkersPage } from "./pages/WorkersPage";
import { JSX } from "react";

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

const renderPage = (renderComponent: JSX.Element, asset: string, title: string) => (
	`
	<!doctype html>
		<html lang="en">
		<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/${asset}.css">
		<title>${title}</title>
		</head>
		<body>
			<div id="root">${renderToString(renderComponent)}</div>
			<script defer src="/assets/${asset}.js"></script>
		</body>
	</html>`
)

export function createApp(pool: Pool) {
	const app = express();
	const localAssets = path.join(__dirname, "public");
	const builtAssets = path.resolve(__dirname, "../dist/src/public");
	app.use("/assets", express.static(existsSync(localAssets) ? localAssets : builtAssets));

	app.get("/", (_req, res) => {
		res.type("html").send(renderPage(<HomePage />, "home", "Healthtech-1 Registration API"));
	});

	app.get("/workers", (_req, res) => {
		res.type("html").send(renderPage(<WorkersPage />, "workers", "Work queue · Healthtech-1"));
	});
	
	app.get("/api/requests", async (_req, res) => {
		try {
			res.json(await listRecentRequests(pool));
		} catch (error) {
			console.error("Request listing failed:", errorMessage(error));
			res.status(503).json({ error: "Could not load requests" });
		}
	});

	app.get("/api/jobs", async (_req, res) => {
		try {
			res.json(await listRecentJobs(pool));
		} catch (error) {
			console.error("Work queue listing failed:", errorMessage(error));
			res.status(503).json({ error: "Could not load work queue" });
		}
	});

	app.post("/api/tickets/:ticketId/requeue", express.json(), async (req, res) => {
		const { ticketId } = req.params;
		const { note, confirmNotDelivered } = req.body ?? {};
		if (!/^[1-9][0-9]*$/.test(ticketId) || typeof note !== "string" || !note.trim()) {
			res.status(400).json({ error: "A valid ticket ID and non-blank audit note are required" });
			return;
		}
		try {
			await requeueTicket(pool, ticketId, { note: note.trim(), confirmNotDelivered: confirmNotDelivered === true });
			res.json({ status: "requeued" });
		} catch (error) {
			res.status(409).json({ error: errorMessage(error) });
		}
	});

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
