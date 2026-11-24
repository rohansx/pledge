# Build context: the repository root.
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @pledge/web
COPY apps/web apps/web
RUN pnpm --filter @pledge/web build
# The viewer for browser recordings: static files shipped inside playwright-core, served at /trace/.
# Keep the version at or above the one the sandbox records with (spikes/s4_browser_snapshot.py).
RUN cd /tmp && npm pack --silent playwright-core@1.56.1 && tar -xzf playwright-core-1.56.1.tgz \
  && mv package/lib/vite/traceViewer /repo/apps/web/dist/trace

FROM nginx:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
# The deploy smoke test reads this to confirm which build is live.
ARG PLEDGE_VERSION=dev
RUN echo "$PLEDGE_VERSION" > /usr/share/nginx/html/version.txt
EXPOSE 80
