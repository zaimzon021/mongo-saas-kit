import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createShopVoltCheckout } from "../src/shopvolt-checkout";

// Same Node-version rule as real-mongo.test.ts: mongodb-memory-server
// requires Node 20.19+, so on older Node this suite is skipped, not failed.
const major = Number(process.version.replace(/^v/, "").split(".")[0]);
const describeReal = major >= 20 ? describe : describe.skip;

describeReal("ShopVolt-style checkout on real MongoDB", () => {
  let replSet: MongoMemoryReplSet;
  let client: MongoClient;
  let db: Db;
  let checkout: ReturnType<typeof createShopVoltCheckout>;

  before(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    client = new MongoClient(replSet.getUri());
    await client.connect();
    db = client.db("shopvolt-test");
    checkout = createShopVoltCheckout({
      client: client as never,
      stockRaw: db.collection("stock"),
      ordersRaw: db.collection("orders"),
      orderItemsRaw: db.collection("order_items"),
      paymentsRaw: db.collection("payments"),
    });
  });

  after(async () => {
    await client.close();
    await replSet.stop();
  });

  async function seed() {
    await db.collection("stock").deleteMany({});
    await db.collection("orders").deleteMany({});
    await db.collection("order_items").deleteMany({});
    await db.collection("payments").deleteMany({});
    await db.collection("stock").insertMany([
      { productId: 1, qty: 5, tenantId: "tenant-a" },
      { productId: 2, qty: 2, tenantId: "tenant-a" },
    ]);
    await db.collection("payments").insertOne({ id: 10, userId: 7, amount: 70, used: false, tenantId: "tenant-a" });
  }

  it("creates a multi-item order, decrements stock, and marks payment used", async () => {
    await seed();
    const result = await checkout({
      tenantId: "tenant-a",
      userId: 7,
      items: [
        { productId: 1, quantity: 2, price: 20 },
        { productId: 2, quantity: 1, price: 30 },
      ],
      shippingAddress: "1 Test Street",
      paymentMethod: "card",
      paymentId: 10,
    });
    assert.match(result.orderNumber, /^ORD-/);
    assert.equal((await db.collection("stock").findOne({ productId: 1, tenantId: "tenant-a" }))?.qty, 3);
    assert.equal((await db.collection("stock").findOne({ productId: 2, tenantId: "tenant-a" }))?.qty, 1);
    assert.equal(await db.collection("orders").countDocuments({ tenantId: "tenant-a" }), 1);
    assert.equal(await db.collection("order_items").countDocuments({ tenantId: "tenant-a" }), 2);
    assert.equal((await db.collection("payments").findOne({ id: 10, tenantId: "tenant-a" }))?.used, true);
  });

  it("aborts everything when one item is out of stock", async () => {
    await seed();
    await assert.rejects(
      checkout({
        tenantId: "tenant-a",
        userId: 7,
        items: [{ productId: 2, quantity: 5, price: 14 }],
        shippingAddress: "1 Test Street",
        paymentMethod: "card",
        paymentId: 10,
      }),
      (e: unknown) => (e as { cause?: Error }).cause?.message === "Out of stock for product 2",
    );
    assert.equal(await db.collection("orders").countDocuments({ tenantId: "tenant-a" }), 0);
    assert.equal((await db.collection("stock").findOne({ productId: 2, tenantId: "tenant-a" }))?.qty, 2);
    assert.equal((await db.collection("payments").findOne({ id: 10, tenantId: "tenant-a" }))?.used, false);
  });

  it("does not let tenant-b use tenant-a's payment or stock", async () => {
    await seed();
    await assert.rejects(
      checkout({
        tenantId: "tenant-b",
        userId: 7,
        items: [{ productId: 1, quantity: 1, price: 20 }],
        shippingAddress: "1 Test Street",
        paymentMethod: "card",
        paymentId: 10,
      }),
      (e: unknown) => (e as { cause?: Error }).cause?.message === "Payment not found",
    );
    assert.equal(await db.collection("orders").countDocuments({}), 0);
  });
});
