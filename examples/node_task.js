"use strict";
const { LeaseQClient, runWorker } = require("../sdks/node");

const client = new LeaseQClient("http://127.0.0.1:8000", process.env.LEASEQ_API_TOKEN);
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());

runWorker(client, "node-example", {
  greet: async (job, context) => ({
    message: `Hello, ${job.payload.name}!`,
    // Use context.jobKey as the idempotency key for external side effects.
  }),
}, { signal: stop.signal }).catch((error) => {
  if (error.name === "AuthenticationError") process.exitCode = 1;
});
