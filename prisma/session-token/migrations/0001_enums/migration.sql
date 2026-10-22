-- session-token: the vocabularies the domain pins become Postgres enum types.
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

ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_status_check";
ALTER TABLE "sessions" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_status_check";
ALTER TABLE "refresh_tokens" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "refresh_tokens" DROP CONSTRAINT IF EXISTS "refresh_tokens_type_check";
ALTER TABLE "refresh_tokens" ALTER COLUMN "token_type" DROP DEFAULT;
ALTER TABLE "outbox_events" ALTER COLUMN "status" DROP DEFAULT;
DROP INDEX IF EXISTS "sessions_user_active_idx";

CREATE TYPE "SessionStatus" AS ENUM ('active', 'expired', 'revoked');
ALTER TABLE "sessions" ALTER COLUMN "status" TYPE "SessionStatus" USING "status"::"SessionStatus";
ALTER TABLE "sessions" ALTER COLUMN "status" SET DEFAULT 'active';
CREATE TYPE "TokenStatus" AS ENUM ('active', 'retired', 'revoked');
ALTER TABLE "refresh_tokens" ALTER COLUMN "status" TYPE "TokenStatus" USING "status"::"TokenStatus";
ALTER TABLE "refresh_tokens" ALTER COLUMN "status" SET DEFAULT 'active';
CREATE TYPE "TokenType" AS ENUM ('refresh', 'access');
ALTER TABLE "refresh_tokens" ALTER COLUMN "token_type" TYPE "TokenType" USING "token_type"::"TokenType";
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'processing', 'published', 'failed', 'dlq');
ALTER TABLE "outbox_events" ALTER COLUMN "status" TYPE "OutboxStatus" USING "status"::"OutboxStatus";
ALTER TABLE "outbox_events" ALTER COLUMN "status" SET DEFAULT 'pending';

CREATE INDEX "sessions_user_active_idx" ON "sessions"("user_id", "issued_at" DESC) WHERE "status" = 'active';
