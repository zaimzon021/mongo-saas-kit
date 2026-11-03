/**
 * Minimal session/client shapes.
 *
 * mongo-transact deliberately depends on these small interfaces, not on a
 * concrete MongoDB driver version. That is what makes it testable without a
 * live database, and usable with the official `mongodb` driver, Mongoose
 * sessions, or a test double.
 *
 * A real `mongodb` ClientSession satisfies `TransactionSession` structurally.
 */
export interface TransactionSession {
  startTransaction(options?: Record<string, unknown>): void | Promise<void>;
  commitTransaction(): void | Promise<void>;
  abortTransaction(): void | Promise<void>;
  endSession(): void | Promise<void>;
  /** Optional: drivers expose this; it is used only for diagnostics. */
  id?: unknown;
}

export interface TransactionClient {
  startSession(options?: Record<string, unknown>): TransactionSession | Promise<TransactionSession>;
}

export interface RetryInfo {
  attempt: number;
  error: unknown;
  /** Milliseconds waited before the next attempt. */
  delayMs: number;
}

export interface TransactionOptions {
  /**
   * How many times to run the callback in total, including the first try.
   * Default 3. Set to 1 to disable retries.
   */
  maxAttempts?: number;
  /** Base delay before the first retry. Default 100ms. Doubles each retry. */
  baseDelayMs?: number;
  /** Maximum delay between retries. Default 5000ms. */
  maxDelayMs?: number;
  /**
   * Abort the transaction if it has not committed within this time.
   * Default: no timeout (pass a value in production).
   */
  timeoutMs?: number;
  /** Options forwarded to the driver's startTransaction(). */
  transactionOptions?: Record<string, unknown>;
  /** Called before each retry. Useful for logging / metrics. */
  onRetry?: (info: RetryInfo) => void;
  /** Called after a successful commit. */
  onCommit?: (attempt: number) => void;
  /** Called after an abort that will not be retried. */
  onAbort?: (error: unknown, attempt: number) => void;
  /**
   * Extra predicate for retryable errors, in addition to MongoDB's
   * TransientTransactionError / UnknownTransactionCommitResult labels.
   * Return true only for errors that are genuinely safe to retry.
   */
  isRetryable?: (error: unknown) => boolean;
}

export type TransactionCallback<T> = (session: TransactionSession) => Promise<T> | T;
