# mongo-tenant-guard

Fail-closed multi-tenant isolation for MongoDB in TypeScript.

In a SaaS app, the most dangerous bug is also the most boring one: a
developer forgets `tenantId` in one query, and Tenant A sees Tenant B's
orders, invoices, or messages. No amount of code review reliably catches
every forgotten filter.

`mongo-tenant-guard` makes that bug impossible by construction. Wrap a
collection once, and every operation through it is forced to carry a
tenant — or it does not run at all.

```ts
import { MongoClient } from "mongodb";
import { createTenantGuard, tenantMiddleware } from "mongo-tenant-guard";

const guard = createTenantGuard();
const client = new MongoClient(process.env.MONGODB_URI!);
const orders = guard.wrap(client.db("app").collection("orders"));

// In Express, after auth:
app.use(tenantMiddleware({ getTenantId: (req) => req.user?.tenantId }));

// This query can only ever return the current tenant's orders.
// If there is no tenant in context, it throws TenantRequiredError
// and NOTHING is sent to MongoDB.
app.get("/orders", async (req, res) => {
  const list = await orders.find({ status: "paid" }).toArray();
  res.json(list);
});
```

## The rules

1. **No tenant => no query.** If there is no tenant in context, the
   operation throws `TenantRequiredError` and the database is never touched.
2. **Wrong tenant => no query.** A filter or document that already scopes
   to a different tenant throws `TenantMismatchError`. The guard never
   silently overwrites it.
3. **No tenant in the filter => it is injected.** Plain filters become
   `{ $and: [filter, { tenantId }] }`, so `$or` branches cannot escape.
4. **Updates cannot move data between tenants.** Changing or unsetting
   `tenantId` in an update throws. Upserts set `tenantId` on insert.
5. **Aggregations are scoped too.** A leading `{ $match: { tenantId } }`
   is prepended to every pipeline.
6. **Bypasses are explicit, never accidental.** Global collections are
   listed in `globalCollections`. Everything else needs `.system()`,
   which should only be used for internal jobs and migrations.

## Install

```bash
npm install mongo-tenant-guard
npm install mongodb   # peer / example dependency
```

Requires Node 18+. Full TypeScript types are included.

## API

### `createTenantGuard({ tenantField?, globalCollections? })`

- `tenantField` (default `"tenantId"`): the field that carries the tenant.
- `globalCollections`: collections that are genuinely shared, e.g.
  `"countries"`. Keep this list short. Never put user data in a global
  collection.

### `guard.wrap(collection, explicitTenantId?)`

Returns a guarded collection with `find`, `findOne`, `insertOne`,
`insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`,
`countDocuments`, and `aggregate`. Use `.system()` for an explicit bypass,
and `.raw()` only when you need an operation the guard does not cover.

### `runWithTenant(tenantId, fn)` / `guard.runWithTenant(tenantId, fn)`

Runs `fn` with a tenant in context, using `AsyncLocalStorage` so
concurrent requests cannot leak tenants into each other. A plain global
variable would be unsafe here — this is why the library uses async context.

### `tenantMiddleware({ getTenantId })`

Express middleware. `getTenantId` is **your** auth logic — read it from
`req.user` after JWT/session auth. Never trust a raw client header in
production unless you have verified it.

### Errors

- `TenantRequiredError`: no tenant in context. Map it to 403 in your
  error handler (see `tenantErrorHandler`).
- `TenantMismatchError`: the operation tried to cross tenants, or change
  a document's tenant. Also 403, and also never executed.

## How this pairs with mongo-transact

`mongo-tenant-guard` answers "whose data is this?" — `mongo-transact`
answers "did all of these writes happen together, or none of them?"
Use the guard for isolation, and a transaction (with the session passed
through to the guarded calls) for atomic multi-step writes like checkout.
They are separate libraries on purpose: one job each.

## Development

```bash
npm install
npm test   # builds with tsc, then runs node --test
```

Tests use a fake collection, so no live MongoDB is needed for the unit
suite. The example in `examples/` is documentation code.

## Licence

MIT. See `LICENSE`.
