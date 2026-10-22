-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "outbox_dead_letters" (
    "outbox_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "last_error" TEXT,
    "attempts" INTEGER NOT NULL,
    "trace_id" TEXT,
    "failed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_dead_letters_pkey" PRIMARY KEY ("outbox_id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "locked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "trace_id" TEXT NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "resource_type" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "name" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "outbox_events_claim_idx" ON "outbox_events"("status", "next_attempt_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_sweep_idx" ON "outbox_events"("status", "attempts");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_dedup_idx" ON "outbox_events"("dedup_key", "type");

-- CreateIndex
CREATE INDEX "policies_role_idx" ON "policies"("role");

-- CreateIndex
CREATE INDEX "policies_role_resource_idx" ON "policies"("role", "resource_type");

-- AddForeignKey
ALTER TABLE "outbox_dead_letters" ADD CONSTRAINT "outbox_dead_letters_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "outbox_events"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_role_fkey" FOREIGN KEY ("role") REFERENCES "roles"("name") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_role_fkey" FOREIGN KEY ("role") REFERENCES "roles"("name") ON DELETE RESTRICT ON UPDATE NO ACTION;
