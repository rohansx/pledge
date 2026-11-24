# The control-plane API. It is the Python package in python/, served by uvicorn.
# Build context: the repository root.
FROM python:3.12-slim
WORKDIR /srv
COPY python/pyproject.toml ./
COPY python/pledge ./pledge
RUN pip install --no-cache-dir '.[api]'
ARG PLEDGE_VERSION=dev
ENV PLEDGE_VERSION=$PLEDGE_VERSION PORT=8080 PYTHONUNBUFFERED=1
EXPOSE 8080
USER nobody
# One worker: live run streams poll the database, and a second worker would only add connections.
CMD ["sh", "-c", "exec uvicorn pledge.api.app:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
