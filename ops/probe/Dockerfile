# Maps rate probe (see PROBE.md). Build context: the repo root.
# The base image carries Chromium for Playwright 1.63.0, the exact playwright-core version the repo pins.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

# PP_LIVE=1 lets the core launcher start Chromium. Logs (stderr) only at warn, so stdout is the JSON lines.
ENV PP_LIVE=1 \
    PP_LOG_LEVEL=warn \
    PP_DATA_DIR=/tmp/pp-data \
    CI=1

RUN npm install -g pnpm@9.15.9

# Dependencies first (cached layer), then the source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/maps/package.json packages/maps/
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/registries/package.json packages/registries/
COPY packages/sites/package.json packages/sites/
COPY apps/cli/package.json apps/cli/
RUN pnpm install --frozen-lockfile

COPY . .

# Run the probe once, print its exit code, then idle so the deploy logs stay readable (no restart, no re-run).
CMD pnpm --silent pp probe maps-rate; echo '{"type":"exit","code":'$?'}'; exec sleep infinity
