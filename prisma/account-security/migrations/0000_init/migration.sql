-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "login_history" (
    "login_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID,
    "fingerprint" TEXT NOT NULL,
    "country" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_history_pkey" PRIMARY KEY ("login_id")
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

-- CreateTable
CREATE TABLE "security_signals" (
    "signal_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "signal_type" TEXT NOT NULL,
    "risk_score" INTEGER NOT NULL,
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "security_signals_pkey" PRIMARY KEY ("signal_id")
);

-- CreateIndex
CREATE INDEX "login_history_user_fingerprint_idx" ON "login_history"("user_id", "fingerprint");

-- CreateIndex
CREATE INDEX "login_history_user_occurred_idx" ON "login_history"("user_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_events_claim_idx" ON "outbox_events"("status", "next_attempt_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_sweep_idx" ON "outbox_events"("status", "attempts");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_dedup_idx" ON "outbox_events"("dedup_key", "type");

-- CreateIndex
CREATE INDEX "security_signals_user_detected_idx" ON "security_signals"("user_id", "detected_at" DESC);

-- CreateIndex
CREATE INDEX "security_signals_user_type_idx" ON "security_signals"("user_id", "signal_type", "detected_at" DESC);

-- AddForeignKey
ALTER TABLE "outbox_dead_letters" ADD CONSTRAINT "outbox_dead_letters_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "outbox_events"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
