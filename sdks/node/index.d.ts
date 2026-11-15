export interface Job<T = Record<string, unknown>> {
  id: number;
  kind: string;
  payload: T;
  state: string;
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
  lease_token?: string;
  leased_by: string;
}
export interface LeasedJob<T = Record<string, unknown>> extends Job<T> {
  lease_token: string;
}
export interface SubmitOptions {
  idempotencyKey: string;
  priority?: number;
  maxAttempts?: number;
  runAfter?: string;
  delaySeconds?: number;
}
export interface WorkerContext {
  jobKey: string;
  workerId: string;
  signal?: AbortSignal;
}
export class LeaseQError extends Error {}
export class AuthenticationError extends LeaseQError {}
export class LeaseQClient {
  constructor(apiUrl: string, token: string, timeoutMs?: number);
  submit<T>(kind: string, payload: T, options: SubmitOptions): Promise<Job<T>>;
  claim(workerId: string, kinds: string[], leaseSeconds?: number): Promise<LeasedJob | null>;
  heartbeat(job: LeasedJob, leaseSeconds?: number): Promise<Job>;
  complete(job: LeasedJob, result?: Record<string, unknown> | null): Promise<Job>;
  fail(job: LeasedJob, error: string, permanent?: boolean): Promise<Job>;
}
export function runWorker(
  client: LeaseQClient,
  workerId: string,
  handlers: Record<string, (job: LeasedJob, context: WorkerContext) => Promise<Record<string, unknown>> | Record<string, unknown>>,
  options?: { signal?: AbortSignal; leaseSeconds?: number; pollMs?: number },
): Promise<void>;
