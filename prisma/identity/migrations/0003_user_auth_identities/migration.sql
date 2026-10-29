-- Links an identity-provider account (Google, GitHub) to a local user. The unique
-- (provider, subject) pair is what a returning OAuth sign-in resolves against, and the
-- cascade is what keeps a deleted account from leaving dangling links behind.
CREATE TABLE "user_auth_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_auth_identities_user_idx" ON "user_auth_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_auth_identities_provider_subject_idx" ON "user_auth_identities"("provider", "subject");

-- AddForeignKey
ALTER TABLE "user_auth_identities" ADD CONSTRAINT "user_auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
