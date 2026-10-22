-- access-control: the DDL the hand-written dev schema carried and `schema.prisma` cannot express.
--
-- Postgres offers three constructs Prisma's datamodel has no syntax for: partial indexes
-- (`WHERE ...`), expression indexes (`lower(email)`) and CHECK constraints over plain
-- expressions. None of them is visible to `migrate diff` — pointed at a database that has them
-- and at a schema that does not, that tool answers `-- This is an empty migration.` — so a
-- database built from migrations and one built by hand would diverge without either side being
-- told: this one would be missing the three indexes that keep *revoked* role assignments out of
-- the way, including the uniqueness that forbids the same live assignment twice.
--
-- Every statement below is a no-op when the object already exists, because a dev database created
-- by hand has these objects and a fresh one does not. `CREATE INDEX` takes `IF NOT EXISTS`;
-- `ADD CONSTRAINT` has no such clause, so checks are dropped first and re-added with the
-- definition the hand-written schema used.
--
-- The last two statements reconcile a difference `migrate diff` is blind to as well. Prisma spells
-- a scalar list as `TEXT[] DEFAULT ARRAY[]::TEXT[]` and leaves it nullable, the hand-written
-- schema spelled `'{}'::text[] NOT NULL`; the generated spelling is kept for the default (both
-- name the empty array, and it is the one a regenerated `0000_init` would produce) and `NOT NULL`
-- is kept from the hand-written side, because `permissions` is declared required in
-- `schema.prisma` and the client reports `Expected String[], got null` when it reads a row that
-- slipped in as NULL. Prisma answers `-- This is an empty migration.` to either shape, so neither
-- choice gets relitigated by a later `migrate dev`.

CREATE INDEX IF NOT EXISTS "role_assignments_expiry_idx" ON "role_assignments"("expires_at") WHERE "revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "role_assignments_user_idx" ON "role_assignments"("user_id") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "role_assignments_live_unique" ON "role_assignments"("user_id", "role") WHERE "revoked_at" IS NULL;

ALTER TABLE "roles" ALTER COLUMN "permissions" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "roles" ALTER COLUMN "permissions" SET NOT NULL;
