-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_chain_heads" (
    "partition_key" TEXT NOT NULL,
    "head_hash" TEXT NOT NULL,
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_chain_heads_pkey" PRIMARY KEY ("partition_key")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "partition_key" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "payload" JSONB NOT NULL,
    "trace_id" TEXT NOT NULL,
    "previous_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys"("created_at");

-- CreateIndex
CREATE INDEX "audit_chain_heads_updated_idx" ON "audit_chain_heads"("updated_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_occurred_idx" ON "audit_events"("actor_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_action_occurred_idx" ON "audit_events"("action", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_resource_occurred_idx" ON "audit_events"("resource_type", "resource_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_result_occurred_idx" ON "audit_events"("result", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_occurred_idx" ON "audit_events"("occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_chain_seq_idx" ON "audit_events"("partition_key", "sequence");

-- CreateIndex
CREATE INDEX "outbox_events_claim_idx" ON "outbox_events"("status", "next_attempt_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_sweep_idx" ON "outbox_events"("status", "attempts");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_dedup_idx" ON "outbox_events"("dedup_key", "type");

-- AddForeignKey
ALTER TABLE "outbox_dead_letters" ADD CONSTRAINT "outbox_dead_letters_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "outbox_events"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
