# The control-plane API. It is the Python package in python/, served by uvicorn.
# The pull request worker is this same image started with the command `pledge worker`; see docs/github-app.md.
# Build context: the repository root.
FROM python:3.12-slim
WORKDIR /srv
COPY python/pyproject.toml ./
COPY python/pledge ./pledge
# `scan` and `engine` are for the worker: the E2B SDK, and the engine that tallies the evidence a scan brings
# back. The engine is installed from git, which the slim image lacks, so git is there for this one step.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && pip install --no-cache-dir '.[api,scan,engine]' \
    && apt-get purge -y git && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ARG PLEDGE_VERSION=dev
ENV PLEDGE_VERSION=$PLEDGE_VERSION PORT=8080 PYTHONUNBUFFERED=1
EXPOSE 8080
USER nobody
# One worker: live run streams poll the database, and a second worker would only add connections.
CMD ["sh", "-c", "exec uvicorn pledge.api.app:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
