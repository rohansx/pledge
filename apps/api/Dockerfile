# Build context: the repository root.
FROM node:24-alpine
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter @pledge/api
COPY apps/api/src apps/api/src
ARG PLEDGE_VERSION=dev
ENV PLEDGE_VERSION=$PLEDGE_VERSION NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
WORKDIR /repo/apps/api
# Node 24 runs TypeScript directly, so there is no build step.
CMD ["node", "src/server.ts"]
