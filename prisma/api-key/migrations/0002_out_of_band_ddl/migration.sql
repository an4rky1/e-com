-- api-key: the DDL the hand-written dev schema carried and `schema.prisma` cannot express.
--
-- Postgres offers three constructs Prisma's datamodel has no syntax for: partial indexes
-- (`WHERE ...`), expression indexes (`lower(email)`) and CHECK constraints over plain
-- expressions. None of them is visible to `migrate diff` — pointed at a database that has them
-- and at a schema that does not, that tool answers `-- This is an empty migration.` — so a
-- database built from migrations and one built by hand would diverge without either side being
-- told. This service's partial index (`api_keys_expiry_idx`) is not among them: `0001_enums` has
-- to drop it before converting `status` and therefore also rebuilds it, and what remains is the
-- scalar list below.
--
-- The two statements reconcile a difference `migrate diff` is blind to as well. Prisma spells a
-- scalar list as `TEXT[] DEFAULT ARRAY[]::TEXT[]` and leaves it nullable, the hand-written schema
-- spelled `'{}'::text[] NOT NULL`; the generated spelling is kept for the default (both name the
-- empty array, and it is the one a regenerated `0000_init` would produce) and `NOT NULL` is kept
-- from the hand-written side, because `scopes` is declared required in `schema.prisma` and the
-- client reports `Expected String[], got null` when it reads a row that slipped in as NULL. Prisma
-- answers `-- This is an empty migration.` to either shape, so neither choice gets relitigated by
-- a later `migrate dev`.

ALTER TABLE "api_keys" ALTER COLUMN "scopes" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "api_keys" ALTER COLUMN "scopes" SET NOT NULL;
