# mongo-transact

Safe, retrying MongoDB transactions for Node.js.

The raw MongoDB driver leaves four jobs to you: start a session, abort on
failure, always end the session, and retry only transient errors. Miss any
one and you get leaked sessions, half-committed writes, or silent retries of
errors that should never be retried.

`mongo-transact` does those four jobs in one call:

```ts
import { MongoClient } from "mongodb";
import { withTransaction } from "mongo-transact";

const client = new MongoClient(process.env.MONGODB_URI!);
await client.connect();

const order = await withTransaction(
  client,
  async (session) => {
    // Pass `session` to every write in here.
    await db.collection("stock").updateOne(
      { sku, qty: { $gte: 1 } },
      { $inc: { qty: -1 } },
      { session },
    );
    await db.collection("orders").insertOne(newOrder, { session });
    return newOrder;
  },
  { maxAttempts: 3, timeoutMs: 10_000 },
);
```

## Why not just use the driver's `withSession`?

The driver's session helper does not retry a whole transaction for you, and
it does not give you a timeout, retry hooks, or a clear error taxonomy.
`mongo-transact` adds exactly that, and nothing else. It is not an ORM, not
a query builder, and not a replacement for MongoDB's own transaction
semantics.

| Raw driver code you have to write | With mongo-transact |
|---|---|
| `startSession()`, `startTransaction()`, `try/catch`, `abortTransaction()`, `endSession()` in `finally` | One `withTransaction()` call |
| Manual check for `TransientTransactionError` / `UnknownTransactionCommitResult` | Retried by default, with exponential backoff and jitter |
| No timeout | `timeoutMs` aborts a stuck transaction |
| Session leak if you forget `finally` | Session is ended in `finally`, always |

## Install

```bash
npm install mongo-transact
# mongodb is a peer dependency (optional for testing with a fake client):
npm install mongodb
```

Requires Node 18+ and TypeScript users get full types from `dist/index.d.ts`.

## API

### `withTransaction(client, fn, options?)`

- `client`: anything with `startSession()` — the official driver client,
  a Mongoose client, or a test double. See `src/types.ts`.
- `fn(session)`: your writes. Pass `session` to every operation.
- Returns whatever `fn` returns, after a successful commit.

Options:

- `maxAttempts` (default `3`): total attempts, including the first.
  Set to `1` to disable retries.
- `baseDelayMs` (default `100`), `maxDelayMs` (default `5000`):
  exponential backoff between retries, with jitter.
- `timeoutMs`: abort if the transaction has not committed in time.
- `transactionOptions`: forwarded to `startTransaction()`.
- `onRetry`, `onCommit`, `onAbort`: observability hooks.
- `isRetryable(error)`: add your own retryable predicate. Use sparingly.

### `createTransactionRunner(client, defaults?)`

Returns a reusable function with defaults baked in, for one app:

```ts
import { createTransactionRunner } from "mongo-transact";

const tx = createTransactionRunner(client, { maxAttempts: 3, timeoutMs: 10_000 });
await tx(async (session) => {
  await db.collection("orders").insertOne(order, { session });
});
```

### Errors

All errors preserve the original error on `.cause`:

- `TransactionAbortedError`: the callback threw, or the transaction was
  rolled back, and it was not retryable.
- `TransactionRetriesExhaustedError`: a retryable error kept happening
  until `maxAttempts` was reached. `.attempts` tells you how many tries.
- `TransactionTimeoutError`: the timeout fired and the transaction was aborted.

## Retries are not magic — read this before you use retries

Retrying a transaction re-runs your callback. That is only safe if your
callback is idempotent, or if you use an idempotency key in your own writes
(for example, a unique `orderId` with an upsert).

Do **not** retry a callback that sends an email, charges a card, or calls
an external API with a side effect, unless that call is itself idempotent.
This library cannot make a non-idempotent side effect safe, and it will not
pretend otherwise.

Only MongoDB transient transaction errors are retried by default.
Validation errors, duplicate-key errors, and programming errors fail fast,
on purpose.

## Example: Express checkout

See `examples/express-checkout.ts` for a complete checkout endpoint:
decrement stock and create the order in one transaction, or neither happens.

## Development

```bash
npm install
npm test   # builds with tsc, then runs node --test
```

Tests use a fake client/session, so no live MongoDB is needed for the unit
suite. The Express example is documentation code and is not run by `npm test`.

## Licence

MIT. See `LICENSE`.
