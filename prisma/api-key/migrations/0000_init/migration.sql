-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "rotated_from_id" UUID,
    "rotation_count" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" TEXT,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

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

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_unique" ON "api_keys"("prefix");

-- CreateIndex
CREATE INDEX "api_keys_user_idx" ON "api_keys"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_user_name_unique" ON "api_keys"("user_id", "name");

-- CreateIndex
CREATE INDEX "outbox_events_claim_idx" ON "outbox_events"("status", "next_attempt_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_sweep_idx" ON "outbox_events"("status", "attempts");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_dedup_idx" ON "outbox_events"("dedup_key", "type");

-- AddForeignKey
ALTER TABLE "outbox_dead_letters" ADD CONSTRAINT "outbox_dead_letters_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "outbox_events"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
