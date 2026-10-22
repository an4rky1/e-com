-- auth-gateway: the vocabularies the domain pins become Postgres enum types.
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
-- Partial indexes are the third blocking object: a predicate over the converted column is
-- re-evaluated while that column is rewritten and no longer resolves against the new type. The
-- index is dropped here and rebuilt at the end of the file — a migration runs as a single
-- transaction (a failed run leaves no `CREATE TYPE` behind, as the five databases that rejected
-- this file demonstrated), so no other session ever observes it missing.

ALTER TABLE "auth_flows" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "auth_flows" ALTER COLUMN "strategy" DROP DEFAULT;
ALTER TABLE "outbox_events" ALTER COLUMN "status" DROP DEFAULT;
DROP INDEX IF EXISTS "auth_flows_open_expires_idx";

CREATE TYPE "AuthFlowState" AS ENUM ('awaiting_credential', 'awaiting_2fa', 'awaiting_step_up', 'completed', 'failed', 'expired', 'cancelled');
ALTER TABLE "auth_flows" ALTER COLUMN "status" TYPE "AuthFlowState" USING (
  CASE "status"
    WHEN 'pending' THEN 'awaiting_credential'
    WHEN 'mfa_required' THEN 'awaiting_2fa'
    ELSE "status"
  END
)::"AuthFlowState";
ALTER TABLE "auth_flows" ALTER COLUMN "status" SET DEFAULT 'awaiting_credential';
CREATE TYPE "AuthFlowType" AS ENUM ('login', 'register', 'reset_password', 'magic_link', 'step_up');
ALTER TABLE "auth_flows" ALTER COLUMN "strategy" TYPE "AuthFlowType" USING (
  CASE "strategy"
    WHEN 'password' THEN 'login'
    ELSE "strategy"
  END
)::"AuthFlowType";
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'processing', 'published', 'failed', 'dlq');
ALTER TABLE "outbox_events" ALTER COLUMN "status" TYPE "OutboxStatus" USING "status"::"OutboxStatus";
ALTER TABLE "outbox_events" ALTER COLUMN "status" SET DEFAULT 'pending';

-- The sweep index selects flows that are still in flight. Its hand-written predicate named four
-- legacy non-terminal states (`pending`, `credential_verified`, `mfa_required`, `mfa_verified`);
-- the enum above names three (`awaiting_*`), which is the same set under today's vocabulary, so
-- the predicate is rewritten rather than carried over — carrying it would match nothing at all.
CREATE INDEX "auth_flows_open_expires_idx" ON "auth_flows"("expires_at") WHERE "status" IN ('awaiting_credential', 'awaiting_2fa', 'awaiting_step_up');
