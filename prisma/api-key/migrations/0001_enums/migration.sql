-- api-key: the vocabularies the domain pins become Postgres enum types.
--
-- Hand-written, not produced by `migrate diff`: that tool turns a String -> enum change into
-- `DROP COLUMN` / `ADD COLUMN`, which would empty the table it is supposed to convert.
--
-- Order is load-bearing. Postgres refuses to change a column's type while a check expression
-- still mentions it, and it rewrites the column's default as part of the change — which fails
-- when the old default is not a member of the new type (`pending` on auth_flows.status,
-- `normal` on notifications.severity). Both are therefore dropped first and restored after.
--
-- Where a legacy value has an unambiguous successor in today's vocabulary it is rewritten in
-- the USING clause; columns whose history does not map cleanly are left as text on purpose
-- (auth_flow_steps) rather than have an audit trail reinterpreted to fit the current machine.
--
-- Partial indexes are the third blocking object: `WHERE status = 'active'` is re-evaluated while
-- the column is rewritten and no longer resolves against the new type. They are dropped here and
-- rebuilt at the end of the file — a migration runs as a single transaction (a failed run leaves
-- no `CREATE TYPE` behind, as the five databases that rejected this file demonstrated), so no
-- other session ever observes the index missing.

ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_status_check";
ALTER TABLE "api_keys" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "outbox_events" ALTER COLUMN "status" DROP DEFAULT;
DROP INDEX IF EXISTS "api_keys_expiry_idx";

CREATE TYPE "ApiKeyStatus" AS ENUM ('active', 'revoked', 'expired');
ALTER TABLE "api_keys" ALTER COLUMN "status" TYPE "ApiKeyStatus" USING "status"::"ApiKeyStatus";
ALTER TABLE "api_keys" ALTER COLUMN "status" SET DEFAULT 'active';
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'processing', 'published', 'failed', 'dlq');
ALTER TABLE "outbox_events" ALTER COLUMN "status" TYPE "OutboxStatus" USING "status"::"OutboxStatus";
ALTER TABLE "outbox_events" ALTER COLUMN "status" SET DEFAULT 'pending';

CREATE INDEX "api_keys_expiry_idx" ON "api_keys"("expires_at") WHERE "status" = 'active';
