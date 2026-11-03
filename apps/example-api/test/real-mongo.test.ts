import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createCheckout } from "../src/checkout";

/**
 * Integration test against a REAL MongoDB (in-memory replica set,
 * because transactions require a replica set). First run downloads
 * a mongod binary, so it takes longer than the fake-client tests.
 * This is the test that proves the guard and the transaction work
 * against the real driver, not just against fakes.
 */
describe("real MongoDB checkout integration", () => {
  let replSet: MongoMemoryReplSet;
  let client: MongoClient;
  let db: Db;
  let checkout: ReturnType<typeof createCheckout>;

  before(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    client = new MongoClient(replSet.getUri());
    await client.connect();
    db = client.db("saas-test");
    checkout = createCheckout({
      client: client as never,
      ordersRaw: db.collection("orders"),
      stockRaw: db.collection("stock"),
    });
  });

  after(async () => {
    await client.close();
    await replSet.stop();
  });

  it("checks out against real MongoDB and commits stock + order together", async () => {
    await db.collection("stock").deleteMany({});
    await db.collection("orders").deleteMany({});
    await db.collection("stock").insertOne({ sku: "SKU-1", qty: 2, tenantId: "tenant-a" });
    const order = await checkout({ tenantId: "tenant-a", sku: "SKU-1", userId: "user-1" });
    assert.equal(order.sku, "SKU-1");
    assert.equal((await db.collection("stock").findOne({ sku: "SKU-1", tenantId: "tenant-a" }))?.qty, 1);
    assert.equal(await db.collection("orders").countDocuments({ tenantId: "tenant-a" }), 1);
  });

  it("does not let tenant-b buy tenant-a's stock in real MongoDB, and leaves it untouched", async () => {
    await assert.rejects(
      checkout({ tenantId: "tenant-b", sku: "SKU-1", userId: "user-2" }),
      (e: unknown) => (e as { cause?: Error }).cause?.message === "Out of stock",
    );
    assert.equal((await db.collection("stock").findOne({ sku: "SKU-1", tenantId: "tenant-a" }))?.qty, 1);
    assert.equal(await db.collection("orders").countDocuments({ tenantId: "tenant-b" }), 0);
  });

  it("aborts on out of stock in real MongoDB and creates no order", async () => {
    await db.collection("stock").updateOne({ sku: "SKU-1", tenantId: "tenant-a" }, { $set: { qty: 0 } });
    await assert.rejects(
      checkout({ tenantId: "tenant-a", sku: "SKU-1", userId: "user-1" }),
      (e: unknown) => (e as { cause?: Error }).cause?.message === "Out of stock",
    );
    assert.equal(await db.collection("orders").countDocuments({ tenantId: "tenant-a" }), 1);
  });
});
