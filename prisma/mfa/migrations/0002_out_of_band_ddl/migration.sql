-- mfa: the DDL the hand-written dev schema carried and `schema.prisma` cannot express.
--
-- Postgres offers three constructs Prisma's datamodel has no syntax for: partial indexes
-- (`WHERE ...`), expression indexes (`lower(email)`) and CHECK constraints over plain
-- expressions. None of them is visible to `migrate diff` — pointed at a database that has them
-- and at a schema that does not, that tool answers `-- This is an empty migration.` — so a
-- database built from migrations and one built by hand would diverge without either side being
-- told: this one would be missing the index that finds unspent backup codes by set. (The unique
-- partial index that predicates on `status` lives in `0001_enums`, which has to drop it before
-- converting the column and therefore also rebuilds it.)
--
-- Every statement below is a no-op when the object already exists, because a dev database created
-- by hand has these objects and a fresh one does not. `CREATE INDEX` takes `IF NOT EXISTS`;
-- `ADD CONSTRAINT` has no such clause, so checks are dropped first and re-added with the
-- definition the hand-written schema used.

CREATE INDEX IF NOT EXISTS "mfa_recovery_codes_unspent_idx" ON "mfa_recovery_codes"("set_id") WHERE "consumed_at" IS NULL;
