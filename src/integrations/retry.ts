/**
 * Retry / backoff policy for integration HTTP calls. Pure (unit-tested): time and randomness are
 * passed in.
 *
 *   - Retries on 429, 5xx (502/503/504/500 by default) and network errors / timeouts.
 *   - Exponential backoff with full jitter: delay = random() * min(maxDelayMs, baseDelayMs * 2^(n-1)).
 *   - Retry-After (seconds or HTTP date) is respected: the delay is at least Retry-After. If the server
 *     asks for longer than maxRetryAfterMs we stop retrying instead of holding the request open.
 *   - Non-idempotent requests (POST without an idempotency key) are only retried when the request
 *     certainly was not processed: 429, or a connection error before anything was sent. A 5xx or a
 *     timeout on a POST may have created the document already, so it is not retried (the export run
 *     records the failure; the idempotency check / findExisting handles the next attempt).
 */

export interface RetryPolicy {
  /** Total attempts including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Longest Retry-After we are willing to wait for. */
  maxRetryAfterMs: number;
  retryStatuses: readonly number[];
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 30_000,
  retryStatuses: [429, 500, 502, 503, 504],
};

/** Network error codes meaning the request never reached the server. */
const NOT_SENT_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

export type AttemptFailure =
  | { kind: 'status'; status: number; retryAfter?: string | null }
  | { kind: 'network'; code?: string | null }
  | { kind: 'timeout' };

export interface RetryDecisionInput {
  /** The attempt that just failed (1-based). */
  attempt: number;
  failure: AttemptFailure;
  idempotent: boolean;
  policy?: RetryPolicy;
  /** Current time in ms (for HTTP-date Retry-After). */
  now?: number;
  /** Random number in [0, 1). */
  random?: number;
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  reason: string;
}

/** Parses Retry-After (delta seconds or HTTP date) to milliseconds from `now`. Null when absent/invalid. */
export function parseRetryAfter(header: string | null | undefined, now: number = Date.now()): number | null {
  if (header === null || header === undefined) return null;
  const value = header.trim();
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(parseFloat(value) * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/** Exponential backoff with full jitter for the attempt that just failed (1-based). */
export function backoffDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY, random: number = Math.random()): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const r = Math.min(Math.max(random, 0), 1);
  return Math.round(r * exp);
}

export function isRetryableStatus(status: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): boolean {
  return policy.retryStatuses.includes(status);
}

export function decideRetry(input: RetryDecisionInput): RetryDecision {
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  const now = input.now ?? Date.now();
  const random = input.random ?? Math.random();
  const { failure, attempt, idempotent } = input;

  if (attempt >= policy.maxAttempts) {
    return { retry: false, delayMs: 0, reason: 'max_attempts' };
  }

  let retryAfterMs: number | null = null;
  if (failure.kind === 'status') {
    if (!isRetryableStatus(failure.status, policy)) {
      return { retry: false, delayMs: 0, reason: `status_${failure.status}_not_retryable` };
    }
    if (!idempotent && failure.status !== 429) {
      return { retry: false, delayMs: 0, reason: 'non_idempotent_may_have_been_processed' };
    }
    retryAfterMs = parseRetryAfter(failure.retryAfter ?? null, now);
    if (retryAfterMs !== null && retryAfterMs > policy.maxRetryAfterMs) {
      return { retry: false, delayMs: 0, reason: 'retry_after_too_long' };
    }
  } else if (failure.kind === 'timeout') {
    if (!idempotent) return { retry: false, delayMs: 0, reason: 'non_idempotent_timeout' };
  } else {
    const code = failure.code ?? '';
    if (!idempotent && !NOT_SENT_ERROR_CODES.has(code)) {
      return { retry: false, delayMs: 0, reason: 'non_idempotent_network_error' };
    }
  }

  const jittered = backoffDelay(attempt, policy, random);
  const delayMs = retryAfterMs !== null ? Math.max(retryAfterMs, jittered) : jittered;
  return { retry: true, delayMs, reason: failure.kind === 'status' ? `status_${failure.status}` : failure.kind };
}
