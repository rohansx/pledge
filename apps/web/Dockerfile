# Build context: the repository root.
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @pledge/web
COPY apps/web apps/web
RUN pnpm --filter @pledge/web build

FROM nginx:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
# The deploy smoke test reads this to confirm which build is live.
ARG PLEDGE_VERSION=dev
RUN echo "$PLEDGE_VERSION" > /usr/share/nginx/html/version.txt
EXPOSE 80
