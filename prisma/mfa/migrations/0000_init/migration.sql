-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "mfa_factors" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "account_label" TEXT,
    "destination_hint" TEXT,
    "secret_ciphertext" TEXT,
    "secret_hash" TEXT,
    "pending_secret_kind" TEXT,
    "pending_secret_value" TEXT,
    "pending_secret_expires_at" TIMESTAMPTZ(6),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMPTZ(6),
    "last_verified_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_code_sets" (
    "set_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "salt" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "regenerated_at" TIMESTAMPTZ(6),

    CONSTRAINT "mfa_recovery_code_sets_pkey" PRIMARY KEY ("set_id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "set_id" UUID NOT NULL,
    "code_index" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("set_id","code_index")
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
CREATE TABLE "totp_used_counters" (
    "factor_id" UUID NOT NULL,
    "last_counter" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "totp_used_counters_pkey" PRIMARY KEY ("factor_id")
);

-- CreateIndex
CREATE INDEX "mfa_factors_user_created_idx" ON "mfa_factors"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "mfa_factors_user_method_created_idx" ON "mfa_factors"("user_id", "method", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mfa_recovery_code_sets_user_unique" ON "mfa_recovery_code_sets"("user_id");

-- CreateIndex
CREATE INDEX "outbox_events_claim_idx" ON "outbox_events"("status", "next_attempt_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_sweep_idx" ON "outbox_events"("status", "attempts");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_dedup_idx" ON "outbox_events"("dedup_key", "type");

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_set_id_fkey" FOREIGN KEY ("set_id") REFERENCES "mfa_recovery_code_sets"("set_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "outbox_dead_letters" ADD CONSTRAINT "outbox_dead_letters_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "outbox_events"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "totp_used_counters" ADD CONSTRAINT "totp_used_counters_factor_id_fkey" FOREIGN KEY ("factor_id") REFERENCES "mfa_factors"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
