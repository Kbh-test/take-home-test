CREATE FUNCTION payload_sha256(payload jsonb) RETURNS text
	LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
	RETURN encode(sha256(convert_to(payload::text, 'UTF8')), 'hex');

CREATE TABLE inbound_forms (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	application_reference text,
	payload jsonb NOT NULL,
	payload_hash text NOT NULL GENERATED ALWAYS AS (payload_sha256(payload)) STORED,
	status text NOT NULL CHECK (status IN ('received', 'transformed', 'blocked')),
	received_count integer NOT NULL DEFAULT 1 CHECK (received_count >= 1),
	first_received_at timestamptz NOT NULL DEFAULT now(),
	last_received_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT inbound_forms_payload_hash_key UNIQUE (payload_hash)
);

CREATE INDEX inbound_forms_accepted_reference_idx
	ON inbound_forms (application_reference)
	WHERE status IN ('received', 'transformed');

CREATE TABLE transformed_forms (
	inbound_form_id uuid PRIMARY KEY REFERENCES inbound_forms (id),
	application_reference text NOT NULL UNIQUE,
	session_id text NOT NULL,
	first_name text NOT NULL,
	last_name text NOT NULL,
	email text NOT NULL,
	gender text NOT NULL CHECK (gender IN ('male', 'female', 'prefer-not-to-say')),
	date_of_birth date NOT NULL,
	phone_number text,
	mobile_number text NOT NULL,
	address_line_1 text NOT NULL,
	address_line_2 text NOT NULL,
	address_line_3 text,
	postcode text NOT NULL,
	country text NOT NULL,
	latitude numeric(9, 6) NOT NULL,
	longitude numeric(9, 6) NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
	id bigserial PRIMARY KEY,
	inbound_form_id uuid NOT NULL REFERENCES inbound_forms (id),
	type text NOT NULL CHECK (type IN ('process_form', 'send_email', 'deliver_formbot')),
	status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'dead')),
	attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	run_after timestamptz NOT NULL DEFAULT now(),
	locked_at timestamptz,
	last_error text,
	CONSTRAINT jobs_inbound_form_id_type_key UNIQUE (inbound_form_id, type),
	CONSTRAINT jobs_id_inbound_form_id_key UNIQUE (id, inbound_form_id)
);

CREATE INDEX jobs_pending_run_after_idx ON jobs (run_after) WHERE status = 'pending';

CREATE TABLE dead_letters (
	id bigserial PRIMARY KEY,
	inbound_form_id uuid NOT NULL REFERENCES inbound_forms (id),
	job_id bigint,
	reason text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	resolved_at timestamptz,
	resolved_by text,
	resolution text CHECK (resolution IN ('requeued', 'closed')),
	resolution_note text,
	CONSTRAINT dead_letters_job_belongs_to_form_fkey FOREIGN KEY (job_id, inbound_form_id)
		REFERENCES jobs (id, inbound_form_id),
	CONSTRAINT dead_letters_resolution_complete CHECK (
		(resolved_at IS NULL) = (resolution IS NULL)
		AND (resolved_at IS NULL) = (resolved_by IS NULL)
	),
	CONSTRAINT dead_letters_close_needs_note CHECK (
		resolution IS DISTINCT FROM 'closed' OR coalesce(btrim(resolution_note), '') <> ''
	)
);

CREATE INDEX dead_letters_open_idx ON dead_letters (created_at) WHERE resolved_at IS NULL;
