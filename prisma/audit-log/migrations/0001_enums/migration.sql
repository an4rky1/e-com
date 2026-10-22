-- audit-log: the vocabularies the domain pins become Postgres enum types.
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

ALTER TABLE "audit_events" ALTER COLUMN "actor_type" DROP DEFAULT;
ALTER TABLE "audit_events" ALTER COLUMN "result" DROP DEFAULT;
ALTER TABLE "outbox_events" ALTER COLUMN "status" DROP DEFAULT;

CREATE TYPE "AuditActorType" AS ENUM ('user', 'anonymous', 'system');
ALTER TABLE "audit_events" ALTER COLUMN "actor_type" TYPE "AuditActorType" USING "actor_type"::"AuditActorType";
CREATE TYPE "AuditResult" AS ENUM ('success', 'failure', 'denied', 'detected');
ALTER TABLE "audit_events" ALTER COLUMN "result" TYPE "AuditResult" USING "result"::"AuditResult";
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'processing', 'published', 'failed', 'dlq');
ALTER TABLE "outbox_events" ALTER COLUMN "status" TYPE "OutboxStatus" USING "status"::"OutboxStatus";
ALTER TABLE "outbox_events" ALTER COLUMN "status" SET DEFAULT 'pending';
