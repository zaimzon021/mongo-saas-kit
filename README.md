# mongo-saas-kit

One project for safe MongoDB SaaS backends in TypeScript.

Most SaaS bugs that actually hurt customers are not exotic. They are:
1. A query that forgets `tenantId`, so one customer sees another customer's data.
2. A multi-step write that half-completes, so stock is decremented but no order exists, or vice versa.

This repo contains both fixes, as two small libraries, plus an example API that uses them together:

- `packages/tenant-guard` — `mongo-tenant-guard`. Every MongoDB query through a wrapped collection is forced to carry a tenant, or it does not run. No tenant, no query. Wrong tenant, no query.
- `packages/transact` — `mongo-transact`. MongoDB transactions with automatic session cleanup, retries only for transient errors, and timeouts.
- `apps/example-api` — A checkout service that uses both: tenant-scoped stock and orders, inside one transaction. Stock decremented + order created, or neither.

## Run the tests

```bash
npm install
npm test
```

Tests use fake collections and fake sessions, so no live MongoDB is needed for the unit and example tests. That is intentional: the libraries are driver-agnostic, and the tests prove the guard and transaction rules, not MongoDB itself.

For a real MongoDB, pass a real `MongoClient` and a real database to the same functions in `apps/example-api`. The example code is written against the driver collection shape, not against the fakes.

## Layout

```
packages/tenant-guard/   tenant isolation library
packages/transact/      transaction library
apps/example-api/       checkout example using both, with tests
docs/                   why this exists, and how to use it
```

## Licence

MIT.
