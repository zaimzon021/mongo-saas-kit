/**
 * Errors thrown by mongo-transact.
 *
 * The original error is always preserved on `cause`, so callers can still
 * inspect MongoDB error codes and labels. Nothing here swallows a failure
 * and pretends the transaction succeeded.
 */
export class TransactionError extends Error {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "TransactionError";
    this.cause = cause;
  }
}

export class TransactionAbortedError extends TransactionError {
  constructor(cause?: unknown) {
    super("Transaction aborted: the callback threw, or the transaction was rolled back.", cause);
    this.name = "TransactionAbortedError";
  }
}

export class TransactionTimeoutError extends TransactionError {
  constructor(timeoutMs: number, cause?: unknown) {
    super(`Transaction timed out after ${timeoutMs}ms and was aborted.`, cause);
    this.name = "TransactionTimeoutError";
  }
}

export class TransactionRetriesExhaustedError extends TransactionError {
  public readonly attempts: number;
  constructor(attempts: number, cause?: unknown) {
    super(`Transaction failed after ${attempts} attempts and will not be retried.`, cause);
    this.name = "TransactionRetriesExhaustedError";
    this.attempts = attempts;
  }
}
