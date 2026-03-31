# PatentCliff MCP — Docker image
#
# Build:  docker build -t patent-cliff .
# Run:    docker run -p 8000:8000 -v patent-cliff-data:/data --env-file .env patent-cliff
#
# The SQLite database lives at /data/patent-cliff.db (mounted volume).
# Populate it before first use by running the pipeline scripts:
#
#   docker run --rm -v patent-cliff-data:/data --env-file .env patent-cliff \
#     bun pipeline/fetch-orangebook.ts
#   docker run --rm -v patent-cliff-data:/data --env-file .env patent-cliff \
#     bun pipeline/fetch-pta.ts
#   docker run --rm -v patent-cliff-data:/data --env-file .env patent-cliff \
#     bun pipeline/fetch-pte.ts
#   docker run --rm -v patent-cliff-data:/data --env-file .env patent-cliff \
#     bun pipeline/fetch-ptab.ts

# ── Stage 1: install production dependencies ──────────────────────────────────
FROM oven/bun:1-alpine AS deps

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM oven/bun:1-alpine

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source
COPY src/ ./src/
COPY pipeline/ ./pipeline/
COPY tsconfig.json ./

# Persistent volume for SQLite database
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8000

ENV PORT=8000
ENV DB_PATH=/data/patent-cliff.db
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["bun", "src/index.ts"]
