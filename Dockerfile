# Full stack in one container: game server + built client + Scryfall card data.
FROM node:22-slim AS build
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @commander/web build
# Card data is fetched at build time so the container starts instantly with the full pool.
RUN pnpm --filter @commander/cards run fetch

FROM node:22-slim
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY --from=build /app ./
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["pnpm", "--filter", "@commander/server", "start"]
