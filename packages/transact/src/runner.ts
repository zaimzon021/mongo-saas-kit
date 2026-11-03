import {
  TransactionAbortedError,
  TransactionRetriesExhaustedError,
  TransactionTimeoutError,
} from "./errors";
import type {
  TransactionCallback,
  TransactionClient,
  TransactionOptions,
  TransactionSession,
} from "./types";

function hasLabel(error: unknown, label: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const labels = (error as { errorLabels?: unknown }).errorLabels;
  return Array.isArray(labels) && labels.includes(label);
}

/**
 * MongoDB's own retryable-transaction labels. These are the only errors
 * retried by default. Anything else fails fast, so a programming error or a
 * validation error is never silently replayed.
 */
export function isRetryableTransactionError(
  error: unknown,
  extra?: (error: unknown) => boolean,
): boolean {
  if (extra?.(error)) return true;
  if (hasLabel(error, "TransientTransactionError")) return true;
  if (hasLabel(error, "UnknownTransactionCommitResult")) return true;
  // 251 is MongoDB's NoSuchTransaction code, seen on stale commit retries.
  if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === 251) return true;
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, base: number, max: number): number {
  const exponential = base * 2 ** (attempt - 1);
  const capped = Math.min(exponential, max);
  // Small jitter so many concurrent retries do not all wake at once.
  return Math.floor(capped * (0.8 + Math.random() * 0.4));
}

/**
 * Run `fn` inside exactly one MongoDB transaction.
 *
 * Guarantees, in plain terms:
 * - The session is always ended, even when fn throws, commit fails, or
 *   the timeout fires. No leaked sessions.
 * - On success, the transaction is committed once. On failure, it is
 *   aborted before the error reaches the caller.
 * - Only retryable transaction errors are retried. Your callback must
 *   therefore be idempotent across retries, or use an idempotency key
 *   in your own writes — retrying a non-idempotent side effect (an
 *   email, a charge) is a caller bug, and this library cannot fix that
 *   for you. See README.md, "Retries are not magic".
 */
export async function withTransaction<T>(
  client: TransactionClient,
  fn: TransactionCallback<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  if (maxAttempts < 1) throw new Error("maxAttempts must be at least 1");

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const session = await client.startSession();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      await session.startTransaction(options.transactionOptions);

      let result: T;
      if (options.timeoutMs !== undefined) {
        result = await Promise.race([
          Promise.resolve(fn(session)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new TransactionTimeoutError(options.timeoutMs as number));
            }, options.timeoutMs);
          }),
        ]);
      } else {
        result = await fn(session);
      }

      await session.commitTransaction();
      options.onCommit?.(attempt);
      return result;
    } catch (error) {
      lastError = error;
      // Always try to abort; never let an abort failure hide the real error.
      try {
        await session.abortTransaction();
      } catch {
        // Intentionally ignored: the original error is the one that matters.
      }

      const retryable = !timedOut && isRetryableTransactionError(error, options.isRetryable);
      if (!retryable || attempt === maxAttempts) {
        options.onAbort?.(error, attempt);
        if (timedOut) throw error;
        if (retryable && attempt === maxAttempts) {
          throw new TransactionRetriesExhaustedError(attempt, error);
        }
        if (error instanceof TransactionTimeoutError) throw error;
        throw new TransactionAbortedError(error);
      }

      const waitMs = backoffMs(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.({ attempt, error, delayMs: waitMs });
      await delay(waitMs);
    } finally {
      if (timer) clearTimeout(timer);
      // endSession in finally: this is the leak-guard.
      try {
        await session.endSession();
      } catch {
        // A failing endSession must not replace a commit/abort result.
      }
    }
  }

  // Unreachable in practice, but TypeScript needs a total function.
  throw new TransactionRetriesExhaustedError(maxAttempts, lastError);
}

/**
 * Create a reusable runner with defaults for one app / one client.
 * Example:
 *   const tx = createTransactionRunner(client, { maxAttempts: 3, timeoutMs: 10000 });
 *   await tx(async (session) => { await orders.insertOne(order, { session }); });
 */
export function createTransactionRunner(
  client: TransactionClient,
  defaults: TransactionOptions = {},
) {
  return <T>(
    fn: TransactionCallback<T>,
    overrides: TransactionOptions = {},
  ): Promise<T> => withTransaction(client, fn, { ...defaults, ...overrides });
}
