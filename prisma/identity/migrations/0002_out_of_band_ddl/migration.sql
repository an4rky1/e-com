-- identity: the DDL the hand-written dev schema carried and `schema.prisma` cannot express.
--
-- Postgres offers three constructs Prisma's datamodel has no syntax for: partial indexes
-- (`WHERE ...`), expression indexes (`lower(email)`) and CHECK constraints over plain
-- expressions. None of them is visible to `migrate diff` — pointed at a database that has them
-- and at a schema that does not, that tool answers `-- This is an empty migration.` — so a
-- database built from migrations and one built by hand would diverge without either side being
-- told: this one would be missing `users_email_unique`, the index that makes case-insensitive
-- address reuse impossible.
--
-- Every statement below is a no-op when the object already exists, because a dev database created
-- by hand has these objects and a fresh one does not. `CREATE INDEX` takes `IF NOT EXISTS`;
-- `ADD CONSTRAINT` has no such clause, so checks are dropped first and re-added with the
-- definition the hand-written schema used.

CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users"(LOWER("email"));
