/**
 * Complete working checkout demo with its own real MongoDB.
 *
 * Run: npm run demo
 * No MongoDB install needed: this starts an in-memory replica set
 * (transactions require a replica set), runs the checkout, prints
 * every result, then stops. For a real deployed MongoDB, set
 * MONGODB_URI to a replica-set URI and use apps/example-api/src/server.ts
 * instead — the checkout code is the same.
 */
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createCheckout } from "./checkout";

async function main(): Promise<void> {
  console.log("Starting a real MongoDB replica set (in-memory)...");
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("saas-demo");

  // Only tenant-a has SKU-1. Tenant-b has nothing for SKU-1.
  await db.collection("stock").insertMany([
    { sku: "SKU-1", qty: 2, tenantId: "tenant-a" },
  ]);
  await db.collection("orders").deleteMany({});

  const checkout = createCheckout({
    client: client as never,
    ordersRaw: db.collection("orders"),
    stockRaw: db.collection("stock"),
  });

  console.log("\n1. tenant-a buys SKU-1 (should succeed)");
  const order1 = await checkout({ tenantId: "tenant-a", sku: "SKU-1", userId: "user-1" });
  console.log("   order created:", JSON.stringify(order1));
  console.log("   tenant-a stock left:", (await db.collection("stock").findOne({ sku: "SKU-1", tenantId: "tenant-a" }))?.qty);

  console.log("\n2. tenant-b tries to buy the same SKU-1 (should FAIL, not steal tenant-a's stock)");
  try {
    await checkout({ tenantId: "tenant-b", sku: "SKU-1", userId: "user-2" });
    console.log("   ERROR: checkout succeeded — tenant isolation is broken");
  } catch (error) {
    console.log("   failed as expected:", (error as { cause?: Error }).cause?.message ?? (error as Error).message);
  }
  console.log("   tenant-a stock still:", (await db.collection("stock").findOne({ sku: "SKU-1", tenantId: "tenant-a" }))?.qty);
  console.log("   tenant-b orders:", await db.collection("orders").countDocuments({ tenantId: "tenant-b" }));

  console.log("\n3. tenant-a buys again, then a third time (second should succeed, third should fail out of stock)");
  await checkout({ tenantId: "tenant-a", sku: "SKU-1", userId: "user-1" });
  console.log("   second purchase ok, stock left:", (await db.collection("stock").findOne({ sku: "SKU-1", tenantId: "tenant-a" }))?.qty);
  try {
    await checkout({ tenantId: "tenant-a", sku: "SKU-1", userId: "user-1" });
    console.log("   ERROR: third purchase succeeded on empty stock");
  } catch (error) {
    console.log("   third purchase failed as expected:", (error as { cause?: Error }).cause?.message ?? (error as Error).message);
  }

  console.log("\nFinal orders in MongoDB:");
  for (const order of await db.collection("orders").find({}).toArray()) {
    console.log("  ", JSON.stringify(order));
  }

  await client.close();
  await replSet.stop();
  console.log("\nDemo complete. MongoDB stopped.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
