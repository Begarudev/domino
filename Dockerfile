# DOMINO public demo: keyless, cache-only. No Crustdata or model keys are set, so the hosted app serves the bundled
# snapshot (data/domino.db) and its template fallbacks and can never spend credits.
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN rm -f .env .env.* && bun run build:web2 && bun run build:classic

FROM oven/bun:1.4
WORKDIR /app
COPY --from=build /app /app
RUN rm -f .env .env.* data/*.db-wal data/*.db-shm
ENV NODE_ENV=production DOMINO_DATA=cache DOMINO_HOST=0.0.0.0 DOMINO_PORT=8080 \
    CRUSTDATA_API_KEY= OPENAI_API_KEY= ANTHROPIC_API_KEY= DOMINO_DELIVERY_KEY=
EXPOSE 8080
CMD ["bun", "server/index.ts"]
