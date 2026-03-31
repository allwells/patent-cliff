FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./

RUN npm install -g bun && bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN bun run build && cp src/cache/schema.sql dist/cache/schema.sql


FROM oven/bun:alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8000
ENV DB_PATH=/data/patent-cliff.db

COPY package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY pipeline/ ./pipeline/

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

CMD ["bun", "dist/index.js"]
