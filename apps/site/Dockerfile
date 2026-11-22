# Build context: the repository root.
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/site/package.json apps/site/
RUN pnpm install --frozen-lockfile --filter @pledge/site...
COPY apps/site apps/site
# Public values only: these are inlined into the static pages. Never pass LOBBY_SECRET_KEY here.
ARG PUBLIC_SITE_URL
ARG PUBLIC_LOBBY_URL
ARG PUBLIC_LOBBY_PROJECT_KEY
ENV PUBLIC_SITE_URL=$PUBLIC_SITE_URL PUBLIC_LOBBY_URL=$PUBLIC_LOBBY_URL PUBLIC_LOBBY_PROJECT_KEY=$PUBLIC_LOBBY_PROJECT_KEY
RUN cd apps/site && pnpm build

FROM nginx:1.29-alpine
COPY apps/site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/site/dist /usr/share/nginx/html
# The deploy smoke test reads this to confirm which build is live.
ARG PLEDGE_VERSION=dev
RUN echo "$PLEDGE_VERSION" > /usr/share/nginx/html/version.txt
EXPOSE 80
