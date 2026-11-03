/**
 * Minimal runnable checkout server, no framework dependency.
 *
 * Usage:
 *   MONGODB_URI="mongodb://localhost:27017/?replicaSet=rs0" npm run server
 *   curl -X POST localhost:3000/checkout -H "x-tenant-id: tenant-a" \
 *     -H "Content-Type: application/json" \
 *     -d '{"sku":"SKU-1","userId":"user-1"}'
 *
 * Requires a replica-set MongoDB URI because checkout uses transactions.
 * The demo (npm run demo) is the zero-setup way to see the same code run.
 */
import { createServer } from "node:http";
import { MongoClient } from "mongodb";
import { createCheckout } from "./checkout";

const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017/?replicaSet=rs0";
const port = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB ?? "saas-demo");
  const checkout = createCheckout({
    client: client as never,
    ordersRaw: db.collection("orders"),
    stockRaw: db.collection("stock"),
  });

  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "POST" && req.url === "/checkout") {
        const tenantId = req.headers["x-tenant-id"];
        if (typeof tenantId !== "string" || !tenantId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing x-tenant-id header" }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { sku?: string; userId?: string };
        if (!body.sku || !body.userId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Body needs sku and userId" }));
          return;
        }
        try {
          const order = await checkout({ tenantId, sku: body.sku, userId: body.userId });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ order }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (error as { cause?: Error }).cause?.message ?? (error as Error).message }));
        }
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    })().catch(() => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
    });
  });

  server.listen(port, () => {
    console.log(`Checkout server listening on http://localhost:${port}`);
    console.log("POST /checkout with header x-tenant-id and JSON body { sku, userId }");
  });
}

main().catch((error: unknown) => {
  console.error("Could not start server. Is MongoDB running at MONGODB_URI?");
  console.error(error);
  process.exit(1);
});
