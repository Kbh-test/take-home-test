import type { Response } from "express";

export const INGEST_BODY_LIMIT = "100kb";

export const HTTP_ERRORS = {
	malformedJson: { status: 400, message: "Request body must be valid JSON" },
	tooLarge: { status: 413, message: `Request body must not exceed ${INGEST_BODY_LIMIT}` },
	unsupportedMediaType: { status: 415, message: "Content-Type must be application/json" },
	unavailable: { status: 503, message: "Service unavailable, retry later" },
} as const;

type HttpError = (typeof HTTP_ERRORS)[keyof typeof HTTP_ERRORS];

export function sendError(res: Response, { status, message }: HttpError): void {
	res.status(status).json({ error: message });
}
