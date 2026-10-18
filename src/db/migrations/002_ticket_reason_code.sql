ALTER TABLE dead_letters ADD COLUMN reason_code text;

UPDATE dead_letters d
SET reason_code = CASE
	WHEN (SELECT type FROM jobs WHERE id = d.job_id) = 'deliver_formbot' THEN 'delivery_uncertain'
	WHEN d.job_id IS NOT NULL THEN 'job_failed'
	WHEN d.reason = 'Missing application_reference' THEN 'missing_reference'
	WHEN d.reason LIKE 'application\_reference already accepted on form %' THEN 'reference_conflict'
	WHEN d.reason LIKE 'Validation failed:%' THEN 'validation_failed'
END;

ALTER TABLE dead_letters
	ALTER COLUMN reason_code SET NOT NULL,
	ADD CONSTRAINT dead_letters_reason_code_check CHECK (reason_code IN (
		'missing_reference',
		'reference_conflict',
		'validation_failed',
		'delivery_uncertain',
		'job_failed'
	));
