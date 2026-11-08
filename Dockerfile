# The backend image: API, bot and worker are the same image with a different command (see docker-entrypoint.sh).
# The JavaScript runtime is a build arg:
#
#   docker build -t gramkit-ts .                       # Node 24 runs the esbuild bundles in dist/ (default)
#   docker build --build-arg RUNTIME=bun -t gramkit-ts:bun .   # Bun runs the TypeScript source, no build step
#
# The frontend has its own image: Dockerfile.frontend.
ARG RUNTIME=node
ARG BUN_VERSION=1.3.5
ARG NODE_VERSION=24

FROM oven/bun:${BUN_VERSION} AS install
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --ignore-scripts
RUN mkdir /production && cp package.json bun.lock bunfig.toml /production/ \
    && cd /production && bun install --frozen-lockfile --production --ignore-scripts

# Only the Node runtime needs the bundles
FROM install AS build
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src/server ./src/server
RUN bun run build

FROM oven/bun:${BUN_VERSION} AS bun-binary

# pg_dump and psql for the backup jobs and scripts; they must not be older than the server (17)
FROM node:${NODE_VERSION}-trixie-slim AS base-node
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 && rm -rf /var/lib/apt/lists/*

FROM debian:trixie-slim AS base-bun
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/sh --uid 1000 node
COPY --from=bun-binary /usr/local/bin/bun /usr/local/bin/bun

# What each runtime runs: the bundles (Node) or the TypeScript source (Bun). Both serve /static from src/server/static.
FROM scratch AS code-node
COPY --from=build /app/dist /app/dist
COPY src/server/static /app/src/server/static

FROM scratch AS code-bun
COPY src/server /app/src/server
COPY tsconfig.json /app/

FROM code-${RUNTIME} AS code

FROM base-${RUNTIME} AS final
ARG RUNTIME
ENV JS_RUNTIME=${RUNTIME} NODE_ENV=production
WORKDIR /app
COPY --from=install /production/node_modules ./node_modules
COPY package.json bunfig.toml ./
COPY --from=code /app ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 8000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["api"]
