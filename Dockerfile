FROM node:24-bookworm-slim AS console-build
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
COPY leaseq/dashboard/assets/ /src/leaseq/dashboard/assets/
RUN npm run build

FROM python:3.13-slim AS dependencies
WORKDIR /deps
COPY requirements-runtime.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements-runtime.txt

FROM python:3.13-slim AS production
WORKDIR /app
COPY --from=dependencies /install /usr/local
COPY leaseq/ leaseq/
COPY --from=console-build /src/leaseq/console/ leaseq/console/
# Package installation belongs to the build stages; the runtime needs no pip.
RUN python -m pip uninstall --yes pip
# Run as an unprivileged user, not root.
RUN useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin leaseq
USER 10001:10001
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/livez',timeout=2)"]
CMD ["sh", "-c", "exec uvicorn leaseq.api:app --host 0.0.0.0 --port \"${PORT:-8000}\" --limit-concurrency 128 --timeout-keep-alive 5 --no-access-log"]
