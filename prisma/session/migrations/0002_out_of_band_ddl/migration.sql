-- session: the DDL the hand-written dev schema carried and `schema.prisma` cannot express.
--
-- Postgres offers three constructs Prisma's datamodel has no syntax for: partial indexes
-- (`WHERE ...`), expression indexes (`lower(email)`) and CHECK constraints over plain
-- expressions. None of them is visible to `migrate diff` — pointed at a database that has them
-- and at a schema that does not, that tool answers `-- This is an empty migration.` — so a
-- database built from migrations and one built by hand would diverge without either side being
-- told: this one would be missing the digest uniqueness (a token replayed under two ids) and
-- `sessions_refresh_window_check`, the invariant that a refresh window outlives the session it
-- extends. (The partial index that predicates on `status` lives in `0001_enums`, which has to
-- drop it before converting the column and therefore also rebuilds it.)
--
-- Every statement below is a no-op when the object already exists, because a dev database created
-- by hand has these objects and a fresh one does not. `CREATE INDEX` takes `IF NOT EXISTS`;
-- `ADD CONSTRAINT` has no such clause, so checks are dropped first and re-added with the
-- definition the hand-written schema used.

CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_digest_unique" ON "refresh_tokens"("token_digest") WHERE "token_digest" IS NOT NULL;

ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_refresh_window_check";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_refresh_window_check" CHECK (refresh_expires_at > expires_at);
