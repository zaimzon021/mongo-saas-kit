import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createTenantGuard,
  runWithTenant,
  TenantMismatchError,
  TenantRequiredError,
} from "../src/index";
import type { GuardedCollectionLike } from "../src/index";

type Call = { method: string; args: unknown[] };

class FakeCollection implements GuardedCollectionLike {
  calls: Call[] = [];
  collectionName = "orders";
  private record(method: string, args: unknown[]): unknown {
    this.calls.push({ method, args });
    return { ok: true };
  }
  find(filter?: Record<string, unknown>, options?: Record<string, unknown>) { return this.record("find", [filter, options]); }
  findOne(filter?: Record<string, unknown>, options?: Record<string, unknown>) { return this.record("findOne", [filter, options]); }
  insertOne(doc: Record<string, unknown>, options?: Record<string, unknown>) { return this.record("insertOne", [doc, options]); }
  insertMany(docs: Record<string, unknown>[], options?: Record<string, unknown>) { return this.record("insertMany", [docs, options]); }
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>) { return this.record("updateOne", [filter, update, options]); }
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>) { return this.record("updateMany", [filter, update, options]); }
  deleteOne(filter: Record<string, unknown>, options?: Record<string, unknown>) { return this.record("deleteOne", [filter, options]); }
  deleteMany(filter: Record<string, unknown>, options?: Record<string, unknown>) { return this.record("deleteMany", [filter, options]); }
  countDocuments(filter?: Record<string, unknown>, options?: Record<string, unknown>) { return this.record("countDocuments", [filter, options]); }
  aggregate(pipeline: Record<string, unknown>[], options?: Record<string, unknown>) { return this.record("aggregate", [pipeline, options]); }
}

describe("mongo-tenant-guard", () => {
  it("injects tenantId into a plain find", async () => {
    const guard = createTenantGuard();
    const inner = new FakeCollection();
    const orders = guard.wrap(inner);
    await runWithTenant("tenant-a", async () => {
      orders.find({ status: "paid" });
    });
    assert.deepEqual(inner.calls[0].args[0], { $and: [{ status: "paid" }, { tenantId: "tenant-a" }] });
  });

  it("fails closed with no tenant, and does not call the database", async () => {
    const guard = createTenantGuard();
    const inner = new FakeCollection();
    const orders = guard.wrap(inner);
    assert.throws(() => orders.find({}), TenantRequiredError);
    assert.equal(inner.calls.length, 0);
  });

  it("blocks a filter that scopes to a different tenant", async () => {
    const guard = createTenantGuard();
    const inner = new FakeCollection();
    const orders = guard.wrap(inner);
    await runWithTenant("tenant-a", async () => {
      assert.throws(() => orders.find({ tenantId: "tenant-b" }), TenantMismatchError);
    });
    assert.equal(inner.calls.length, 0);
  });

  it("wraps $or filters so no branch escapes the tenant", async () => {
    const guard = createTenantGuard();
    const inner = new FakeCollection();
    const orders = guard.wrap(inner);
    await runWithTenant("tenant-a", async () => {
      orders.find({ $or: [{ status: "paid" }, { status: "shipped" }] });
    });
    assert.deepEqual(inner.calls[0].args[0], {
      $and: [{ $or: [{ status: "paid" }, { status: "shipped" }] }, { tenantId: "tenant-a" }],
    });
  });

  it("injects tenantId on insert, and blocks a mismatched insert", async () => {
    const guard = createTenantGuard();
    const inner = new FakeCollection();
    const orders = guard.wrap(inner);
    await runWithTenant("tenant-a", async () => {
      orders.insertOne({ total: 10 });
      assert.deepEqual(inner.calls[0].args[0], { total: 10, tenantId: "tenant-a" });
      assert.throws(() => orders.insertOne({ total: 10, tenantId: "tenant-b" }), TenantMismatchError);
    });
    assert.equal(inner.calls.length, 1);
  });

  it("injects tenantId on insertMany for every document", async () => {
    const guard = createTenantGuard();
    const inner = new FakeCollection();
    const orders = guard.wrap(inner);
    await runWithTenant("tenant-a", async () => {
      orders.insertMany([{ total: 1 }, { total: 2 }]);
    });
    assert.deepEqual(inner.calls[0].args[0], [
      { total: 1, tenantId: "tenant-a" },
      { total: 2, tenantId: "tenant-a" },
    ]);
  });

  it("blocks updates that change or unset tenantId, and sets it on upsert", async () => {
    const guard = createTenantGuard();
    const inner = new FakeCollection();
    const orders = guard.wrap(inner);
    await runWithTenant("tenant-a", async () => {
      assert.throws(
        () => orders.updateOne({ _id: "1" }, { $set: { tenantId: "tenant-b" } }),
        TenantMismatchError,
      );
      assert.throws(
        () => orders.updateOne({ _id: "1" }, { $unset: { tenantId: "" } }),
        TenantMismatchError,
      );
      orders.updateOne({ _id: "1" }, { $set: { status: "paid" } }, { upsert: true });
    });
    const upsertCall = inner.calls[0];
    assert.deepEqual(upsertCall.args[2], {
      upsert: true,
    });
    // $setOnInsert is added by the guard for upserts:
    assert.deepEqual((upsertCall.args[1] as Record<string, unknown>).$setOnInsert, { tenantId: "tenant-a" });
  });

  it("prepends a tenant $match to aggregations", async () => {
    const guard = createTenantGuard();
    const inner = new FakeCollection();
    const orders = guard.wrap(inner);
    await runWithTenant("tenant-a", async () => {
      orders.aggregate([{ $group: { _id: "$status" } }]);
    });
    assert.deepEqual(inner.calls[0].args[0], [
      { $match: { tenantId: "tenant-a" } },
      { $group: { _id: "$status" } },
    ]);
  });

  it("bypasses global collections, and allows an explicit system() scope", async () => {
    const guard = createTenantGuard({ globalCollections: ["countries"] });
    const inner = new FakeCollection();
    inner.collectionName = "countries";
    const countries = guard.wrap(inner);
    // No tenant at all, but global collections are allowed:
    countries.find({});
    assert.deepEqual(inner.calls[0].args[0], {});

    const ordersInner = new FakeCollection();
    const orders = guard.wrap(ordersInner);
    orders.system().find({});
    assert.deepEqual(ordersInner.calls[0].args[0], {});
  });

  it("keeps tenants separate across concurrent contexts", async () => {
    const guard = createTenantGuard();
    const inner = new FakeCollection();
    const orders = guard.wrap(inner);
    await Promise.all([
      runWithTenant("tenant-a", async () => {
        await new Promise((r) => setTimeout(r, 10));
        orders.find({});
      }),
      runWithTenant("tenant-b", async () => {
        orders.find({});
      }),
    ]);
    const filters = inner.calls.map((c) => c.args[0]) as Record<string, unknown>[];
    assert.ok(filters.some((f) => JSON.stringify(f).includes("tenant-a")));
    assert.ok(filters.some((f) => JSON.stringify(f).includes("tenant-b")));
  });
});
