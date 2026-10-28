# Railway pipeline worker. Build context: the repo root. Runs ops/worker/run.sh: migrate, then the `pp` commands in
# PP_JOB (';'-separated), then idles. Chromium comes from the Playwright 1.63.0 image (the repo's playwright-core pin).
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

# PP_CONFIG = the Railway settings (faster pauses, higher daily cap than the office IP). PP_DATA_DIR sits on a volume.
ENV PP_LIVE=1 \
    PP_CONFIG=/app/pp.railway.json \
    PP_DATA_DIR=/data/pp-data \
    CI=1

RUN npm install -g pnpm@9.15.9

# Dependencies first (cached layer), then the source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/maps/package.json packages/maps/
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/registries/package.json packages/registries/
COPY packages/sites/package.json packages/sites/
COPY packages/jobs/package.json packages/jobs/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .

CMD ["sh", "ops/worker/run.sh"]
