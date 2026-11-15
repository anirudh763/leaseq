"""Run with LEASEQ_API_TOKEN and an available LeaseQ API."""
import os
import threading

from leaseq.sdk import LeaseQClient, TaskRegistry, run_worker

registry = TaskRegistry()

@registry.task("greet")
def greet(job, context):
    # Pass context.job_key as the idempotency key to any external side effect.
    return {"message": f"Hello, {job['payload']['name']}!"}

client = LeaseQClient("http://127.0.0.1:8000", os.environ["LEASEQ_API_TOKEN"])
stop = threading.Event()
try:
    run_worker(client, registry, "python-example", stop)
finally:
    stop.set()
    client.close()
