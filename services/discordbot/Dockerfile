FROM oven/bun:1.3.13-slim

WORKDIR /repo
ENV NODE_ENV=production

RUN bun install -g pnpm@10.28.1

# Manifests first for a cached install layer. Unlike the v1 slackbot, discordbot depends on
# workspace packages, so their package.json files must be present to resolve `workspace:*` deps.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/harness-events/package.json packages/harness-events/package.json
COPY packages/rendering/package.json packages/rendering/package.json
COPY packages/chat-session-bridge/package.json packages/chat-session-bridge/package.json
COPY services/discordbot/package.json services/discordbot/package.json
RUN pnpm install --filter discordbot --prod --frozen-lockfile

COPY packages/ packages/
COPY services/discordbot/ services/discordbot/
WORKDIR /repo/services/discordbot

EXPOSE 3001
ENV PORT=3001
CMD ["bun", "src/server.ts"]
