-- mfa: the vocabularies the domain pins become Postgres enum types.
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

ALTER TABLE "mfa_factors" DROP CONSTRAINT IF EXISTS "mfa_factors_method_check";
ALTER TABLE "mfa_factors" ALTER COLUMN "method" DROP DEFAULT;
ALTER TABLE "mfa_factors" DROP CONSTRAINT IF EXISTS "mfa_factors_status_check";
ALTER TABLE "mfa_factors" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "outbox_events" ALTER COLUMN "status" DROP DEFAULT;
DROP INDEX IF EXISTS "mfa_factors_user_method_active_unique";

CREATE TYPE "MfaMethod" AS ENUM ('totp', 'backup_code');
ALTER TABLE "mfa_factors" ALTER COLUMN "method" TYPE "MfaMethod" USING "method"::"MfaMethod";
CREATE TYPE "MfaStatus" AS ENUM ('unverified', 'pending', 'active', 'disabled');
ALTER TABLE "mfa_factors" ALTER COLUMN "status" TYPE "MfaStatus" USING "status"::"MfaStatus";
ALTER TABLE "mfa_factors" ALTER COLUMN "status" SET DEFAULT 'pending';
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'processing', 'published', 'failed', 'dlq');
ALTER TABLE "outbox_events" ALTER COLUMN "status" TYPE "OutboxStatus" USING "status"::"OutboxStatus";
ALTER TABLE "outbox_events" ALTER COLUMN "status" SET DEFAULT 'pending';

CREATE UNIQUE INDEX "mfa_factors_user_method_active_unique" ON "mfa_factors"("user_id", "method") WHERE "status" = 'active';
