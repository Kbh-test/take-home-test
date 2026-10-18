# Tests

## Run Test

Start Postgres first. This creates `.env`, starts Postgres 18 in Docker and applies migrations:

```bash
npm run db:setup
```

Then run all tests:

```bash
npm test
```

To run one file:

```bash
npm test -- tests/<file>.test.ts
```

Database-backed tests use throwaway `test_<uuid>` databases. The tests themselves do not modify the dev database; `db:setup` above does apply migrations to it.

## Resilience scenarios

| Scenario | Tests | Coverage |
|---|---|---|
| Happy-path processing and delivery | [pipeline.test.ts](pipeline.test.ts) | Full|
| Duplicate submissions create one processing obligation | [ingest.test.ts](ingest.test.ts) | Full  |
| Conflicting submissions keep both versions | [ingest.test.ts](ingest.test.ts) | Full |
| Schema drift preserves the payload for replay | [scenarios.test.ts](scenarios.test.ts) | Full |
| Provider retries don't repeat completed stages | [scenarios.test.ts](scenarios.test.ts) | Full  |
| Restart resumes unfinished jobs | [worker.test.ts](worker.test.ts) | Partial |
| A crash after FORM-BOT accepts never sends it twice | [worker.test.ts](worker.test.ts) | Partial|
| A crash before the FORM-BOT call gives `dead` + ticket, zero calls | [worker.test.ts](worker.test.ts) | Partial (FORM-BOT is never called) |

## What each test file covers

| File | Covers |
|------|--------|
| [app.test.ts](app.test.ts) | HTTP errors on `POST /ingest`: malformed JSON, empty body, oversized body, wrong content type. |
| [ingest.test.ts](ingest.test.ts) | Ingest storage: duplicates, conflicting versions, missing references, odd payloads, concurrency, rollback on failure. |
| [worker.test.ts](worker.test.ts) | Job worker: claiming, retries and backoff, dead jobs and tickets, shutdown, restart recovery, worker lock. |
| [delivery.test.ts](delivery.test.ts) | Email and FORM-BOT handlers: payload shape, provider errors and redirects, provider timeouts. |
| [process_form.test.ts](process_form.test.ts) | `processForm`: transform, geocode, queue deliveries, block invalid forms, re-runs, rollback. |
| [pipeline.test.ts](pipeline.test.ts) | End to end: ingest, process, email and FORM-BOT delivery with a real worker. |
| [scenarios.test.ts](scenarios.test.ts) | Integration: schema-drift replay and provider retries through the full pipeline. |
| [cli.test.ts](cli.test.ts) | Review ticket CLI: list, requeue and close tickets, and the allowed status transitions. |
| [server.test.ts](server.test.ts) | `startService`: startup, graceful shutdown and failure handling for the API and worker. |
| [transform.test.ts](transform.test.ts) | `transform()`: field mapping and the cases that block a form. |
| [schema.test.ts](schema.test.ts) | Database schema constraints: duplicates, statuses, counters, ticket rules. |
| [migrate.test.ts](migrate.test.ts) | Migration runner: ordering, idempotency, rollback, concurrent runs, file naming. |
