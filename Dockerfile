# syntax=docker/dockerfile:1.7
#
# Single-image build that runs the Next.js dashboard AND the sync scripts
# (Playwright/Chromium for NBG, pytr/Python for Trade Republic).
#
# Build:
#   docker build -t portfolio-tracker .
#
# Run (serves dashboard on :3000):
#   docker compose up -d
#
# Run a sync inside the running container:
#   docker compose exec app npm run sync:tr
#   docker compose exec app npm run sync:nbg
#
# Or one-time pytr login (interactive — pipes SMS prompt to your terminal):
#   docker compose run --rm app pytr login

ARG NODE_VERSION=22
ARG PYTHON_VERSION=3.12

# ---------- 1. install JS deps ----------
FROM node:${NODE_VERSION}-slim AS jsdeps
WORKDIR /app
COPY package.json package-lock.json* ./
# Don't drop optionalDependencies — Tailwind v4 / Next 16 ship platform-
# specific native binaries (lightningcss, swc) under optionalDependencies,
# and `npm ci --omit=optional` removes the matching arch and breaks the build.
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ---------- 2. build Next.js ----------
FROM node:${NODE_VERSION}-slim AS jsbuild
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=jsdeps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- 3. runtime image ----------
# We use Microsoft's Playwright image: it ships Chromium + every system lib
# Playwright needs, plus Node and Python. Saves ~500 MB of apt-get fiddling.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS runtime

# Install Python + pip (Playwright image has Node 22 preinstalled).
# poppler-utils ships `pdftotext`, used by sync-aade-card to extract the
# monthly Ποσό-Συναλλαγών rows from AADE's Oracle-Reports PDF.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv ca-certificates poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # pytr writes credentials/cache here; mount /data as a volume so they persist.
    HOME=/data

# Python deps. The Playwright image is Ubuntu Jammy (22.04) which ships pip
# 22.x — no PEP 668 marker, so a plain system-wide install works.
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

# Production JS deps + built Next.js output
COPY --from=jsdeps /app/node_modules ./node_modules
COPY --from=jsbuild /app/.next ./.next
COPY --from=jsbuild /app/public ./public
COPY --from=jsbuild /app/package.json ./package.json
COPY --from=jsbuild /app/next.config.ts ./next.config.ts
COPY --from=jsbuild /app/tsconfig.json ./tsconfig.json

# Sync scripts and source needed at runtime by tsx
COPY scripts ./scripts
COPY src ./src

# Stage data dir (mounted as volume in compose)
RUN mkdir -p /data/.pytr /data/portfolio /data/nbg/profile

EXPOSE 3000

# `node-pre-built` start; sync runs come via `docker exec ... npm run sync:*`.
CMD ["npm", "run", "start"]
