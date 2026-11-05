FROM node:22-slim

ENV TZ=Asia/Seoul
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/bot/package.json apps/bot/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm --filter web build

ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
CMD ["node_modules/.bin/tsx", "apps/bot/src/main.ts"]
