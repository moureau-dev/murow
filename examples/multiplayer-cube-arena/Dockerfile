# syntax=docker/dockerfile:1.7

# Build the monorepo packages, then the example's server + client bundle.
FROM oven/bun:1-alpine AS build
WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile
RUN bun run build

WORKDIR /app/examples/multiplayer-cube-arena
RUN bun run build

# Runtime only needs Bun and the built dist/ (server inlines murow).
FROM oven/bun:1-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

COPY --from=build /app/examples/multiplayer-cube-arena/dist/ ./

EXPOSE 4000
USER bun

CMD ["bun", "server.js"]
