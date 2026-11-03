import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCheckout } from "../src/checkout";

type Doc = Record<string, unknown>;

function matches(doc: Doc, filter: Doc): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and") {
      if (!Array.isArray(value) || !(value as Doc[]).every((sub) => matches(doc, sub))) return false;
      continue;
    }
    if (key === "$or") {
      if (!Array.isArray(value) || !(value as Doc[]).some((sub) => matches(doc, sub))) return false;
      continue;
    }
    if (typeof value === "object" && value !== null && "$gte" in (value as Doc)) {
      if (!((doc[key] as number) >= ((value as Doc).$gte as number))) return false;
      continue;
    }
    if (doc[key] !== value) return false;
  }
  return true;
}

class FakeSession {
  committed = false;
  aborted = false;
  ended = false;
  async startTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> { this.committed = true; }
  async abortTransaction(): Promise<void> { this.aborted = true; }
  async endSession(): Promise<void> { this.ended = true; }
}

class FakeClient {
  sessions: FakeSession[] = [];
  async startSession(): Promise<FakeSession> {
    const s = new FakeSession();
    this.sessions.push(s);
    return s;
  }
}

class FakeCollection {
  calls: unknown[] = [];
  constructor(public store: Doc[], public collectionName: string) {}
  async findOne(filter: Doc = {}): Promise<Doc | null> {
    this.calls.push(["findOne", filter]);
    return this.store.find((d) => matches(d, filter)) ?? null;
  }
  async updateOne(filter: Doc, update: Doc): Promise<{ modifiedCount: number }> {
    this.calls.push(["updateOne", filter, update]);
    const doc = this.store.find((d) => matches(d, filter));
    if (!doc) return { modifiedCount: 0 };
    const inc = (update.$inc ?? {}) as Doc;
    for (const [k, v] of Object.entries(inc)) doc[k] = ((doc[k] as number) ?? 0) + (v as number);
    return { modifiedCount: 1 };
  }
  async insertOne(doc: Doc): Promise<{ insertedId: number }> {
    this.calls.push(["insertOne", doc]);
    this.store.push({ ...doc });
    return { insertedId: this.store.length };
  }
  // Stubs so the collection shape is complete for the guard wrapper.
  async find(): Promise<Doc[]> { return []; }
  async findOneAndUpdate(): Promise<null> { return null; }
}

describe("example checkout: tenant guard + transaction together", () => {
  it("checks out for the right tenant and commits", async () => {
    const client = new FakeClient();
    const stock = new FakeCollection([{ sku: "SKU-1", qty: 2, tenantId: "tenant-a" }], "stock");
    const orders = new FakeCollection([], "orders");
    const checkout = createCheckout({ client: client as never, ordersRaw: orders, stockRaw: stock });
    const order = await checkout({ tenantId: "tenant-a", sku: "SKU-1", userId: "user-1" });
    assert.equal(order.sku, "SKU-1");
    assert.equal((stock.store[0] as Doc).qty, 1);
    assert.equal(orders.store.length, 1);
    assert.equal((orders.store[0] as Doc).tenantId, "tenant-a");
    assert.equal(client.sessions[0].committed, true);
    assert.equal(client.sessions[0].ended, true);
  });

  it("does not let tenant B buy tenant A's stock, and aborts", async () => {
    const client = new FakeClient();
    const stock = new FakeCollection([{ sku: "SKU-1", qty: 2, tenantId: "tenant-a" }], "stock");
    const orders = new FakeCollection([], "orders");
    const checkout = createCheckout({ client: client as never, ordersRaw: orders, stockRaw: stock });
    await assert.rejects(checkout({ tenantId: "tenant-b", sku: "SKU-1", userId: "user-2" }), (e: unknown) => (e as { cause?: Error }).cause?.message === "Out of stock");
    assert.equal((stock.store[0] as Doc).qty, 2);
    assert.equal(orders.store.length, 0);
    assert.equal(client.sessions[0].aborted, true);
  });

  it("aborts on out of stock and creates no order", async () => {
    const client = new FakeClient();
    const stock = new FakeCollection([{ sku: "SKU-1", qty: 0, tenantId: "tenant-a" }], "stock");
    const orders = new FakeCollection([], "orders");
    const checkout = createCheckout({ client: client as never, ordersRaw: orders, stockRaw: stock });
    await assert.rejects(checkout({ tenantId: "tenant-a", sku: "SKU-1", userId: "user-1" }), (e: unknown) => (e as { cause?: Error }).cause?.message === "Out of stock");
    assert.equal(orders.store.length, 0);
    assert.equal(client.sessions[0].aborted, true);
    assert.equal(client.sessions[0].ended, true);
  });
});
