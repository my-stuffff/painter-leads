# Railway web service: the JSON API + the built browser app (apps/web). No browser needed here — scraping runs in
# the workers (ops/worker). Build context: the repo root.
FROM node:22-bookworm-slim

WORKDIR /app
ENV CI=1 \
    NODE_ENV=production \
    PP_CONFIG=/app/pp.railway.json

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
# Railway passes the service variables (NODE_ENV=production) into the build; vite and tsx are dev dependencies.
RUN NODE_ENV=development pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @pp/web build

ENV NODE_ENV=production

EXPOSE 8787
CMD ["pnpm", "--filter", "@pp/web", "start"]
