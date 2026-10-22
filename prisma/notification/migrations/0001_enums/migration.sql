-- notification: the vocabularies the domain pins become Postgres enum types.
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

ALTER TABLE "notifications" ALTER COLUMN "severity" DROP DEFAULT;
ALTER TABLE "notifications" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "notification_deliveries" ALTER COLUMN "channel" DROP DEFAULT;
ALTER TABLE "notification_deliveries" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "outbox_events" ALTER COLUMN "status" DROP DEFAULT;

CREATE TYPE "NotificationSeverity" AS ENUM ('info', 'security', 'critical');
ALTER TABLE "notifications" ALTER COLUMN "severity" TYPE "NotificationSeverity" USING "severity"::"NotificationSeverity";
ALTER TABLE "notifications" ALTER COLUMN "severity" SET DEFAULT 'info';
CREATE TYPE "RecordStatus" AS ENUM ('unread', 'read');
ALTER TABLE "notifications" ALTER COLUMN "status" TYPE "RecordStatus" USING "status"::"RecordStatus";
ALTER TABLE "notifications" ALTER COLUMN "status" SET DEFAULT 'unread';
CREATE TYPE "NotificationChannel" AS ENUM ('email', 'sms', 'push', 'inapp');
ALTER TABLE "notification_deliveries" ALTER COLUMN "channel" TYPE "NotificationChannel" USING "channel"::"NotificationChannel";
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'sent', 'failed', 'skipped');
ALTER TABLE "notification_deliveries" ALTER COLUMN "status" TYPE "DeliveryStatus" USING "status"::"DeliveryStatus";
ALTER TABLE "notification_deliveries" ALTER COLUMN "status" SET DEFAULT 'pending';
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'processing', 'published', 'failed', 'dlq');
ALTER TABLE "outbox_events" ALTER COLUMN "status" TYPE "OutboxStatus" USING "status"::"OutboxStatus";
ALTER TABLE "outbox_events" ALTER COLUMN "status" SET DEFAULT 'pending';
