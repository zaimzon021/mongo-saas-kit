# ShopVolt mirror — why it is a mirror, not a rewrite

ShopVolt's real backend, checked from its public code on 2026-11-03, is
NestJS + TypeORM + PostgreSQL. Its orders are Postgres repositories, not
MongoDB collections.

mongo-tenant-guard and mongo-transact are MongoDB driver libraries.
They cannot be dropped into a Postgres checkout, and rewriting
ShopVolt's backend to MongoDB just to claim an integration would be
dishonest and destructive.

So `apps/example-api/src/shopvolt-checkout.ts` mirrors ShopVolt's
`OrdersService.createOrder` flow on MongoDB instead:

| ShopVolt (Postgres) | Mirror (MongoDB, this repo) |
|---|---|
| validate payment (user, total) | same, tenant-guarded payment lookup |
| create order | same, tenant-guarded insert |
| create order items | same, tenant-guarded inserts |
| mark payment as used | same, inside the transaction |
| (no stock step in ShopVolt's code) | stock check + decrement per item, added — otherwise a store checkout that never checks stock is not a real checkout |

All steps run inside one transaction and under one tenant, so a
failure anywhere aborts everything: no order, no stock change, payment
not marked used, and no other tenant's data touched.

Tests: `apps/example-api/test/shopvolt-checkout.test.ts` runs this
against a real in-memory MongoDB replica set.
