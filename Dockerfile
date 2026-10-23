# syntax=docker/dockerfile:1

# One Dockerfile for the whole platform. Three rules shape it:
#
#  1. The services run through `ts-node transpile-only` (the `serve` target), so the image
#     carries the full install, devDependencies included — there is no separate production
#     bundle step yet, deliberately: the container runs exactly what `make boot-check` runs.
#  2. Prisma clients are generated, never committed, so `npm run generate` runs here — on a
#     Debian base the engines npm already downloaded are the right ones (no NixOS workaround
#     needed; tools/prisma-env.sh only exists for laptops).
#  3. The front's `rewrites()` reads GATEWAY_URL when `next build` evaluates it and bakes the
#     destination into the route manifest, so the gateway URL is a build argument. The runtime
#     ENV below covers `next start` re-reading the config on boot; both must agree.
FROM node:24-bookworm-slim AS base
WORKDIR /app
# `openssl` must be present before npm ci: @prisma/engines picks its binary name from the
# detected libssl version, and without the CLI it falls back to openssl-1.1.x while
# tools/prisma-env.sh hardcodes the 3.0.x paths — generate then aborts on a missing file.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl \
	&& rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=true
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run generate

# Backend service image: APP selects which entry point the container starts.
FROM base AS backend
ARG APP
ENV APP=${APP} TS_NODE_PROJECT=apps/${APP}/tsconfig.app.json
EXPOSE 3000
# Shell form on purpose: $APP expands from the ENV at container start, so one image
# definition covers every service and the ECS task definition only overrides ports and env.
CMD node -r ts-node/register/transpile-only -r tsconfig-paths/register apps/$APP/src/main.ts

# Front image: build-time rewrites target, runtime start.
FROM base AS front
ARG GATEWAY_URL=http://localhost:3000
ENV GATEWAY_URL=${GATEWAY_URL}
RUN cd apps/front && npx next build
WORKDIR /app/apps/front
EXPOSE 3000
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
