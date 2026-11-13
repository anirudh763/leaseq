FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY leaseq/ leaseq/
# Run as an unprivileged user, not root.
RUN useradd --system --no-create-home leaseq
USER leaseq
EXPOSE 8000
CMD ["uvicorn", "leaseq.api:app", "--host", "0.0.0.0", "--port", "8000"]
