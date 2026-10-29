-- The flag that says whether a notification's rendered body may be logged.
--
-- A column rather than a field of `payload` because the question is asked across
-- notifications ("which of these may we print?"), and a JSON payload cannot answer it
-- without reading every row. Defaulted false: a notification whose flag was never set is
-- the one whose body must not reach a log.
ALTER TABLE "notifications" ADD COLUMN "log_body" BOOLEAN NOT NULL DEFAULT false;
