FROM python:3.13-slim AS production
WORKDIR /app
COPY requirements-runtime.txt .
RUN pip install --no-cache-dir -r requirements-runtime.txt
COPY leaseq/ leaseq/
# Run as an unprivileged user, not root.
RUN useradd --system --no-create-home leaseq
USER leaseq
EXPOSE 8000
CMD ["sh", "-c", "exec uvicorn leaseq.api:app --host 0.0.0.0 --port \"${PORT:-8000}\""]
