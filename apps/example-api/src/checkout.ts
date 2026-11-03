/**
 * Example SaaS checkout using both libraries together.
 *
 * - TenantGuard scopes every query to the current tenant, so Tenant A
 *   can never read or decrement Tenant B's stock.
 * - withTransaction wraps the whole checkout, so stock decrement and
 *   order creation commit together, or neither does.
 *
 * This file is written against the driver collection shape, so the same
 * code works with a real MongoClient/database. Tests use fake collections
 * with the same shape.
 */
import { createTenantGuard, runWithTenant } from "../../../packages/tenant-guard/src/index";
import { createTransactionRunner } from "../../../packages/transact/src/index";

export interface CheckoutDeps {
  client: { startSession: () => unknown };
  ordersRaw: unknown;
  stockRaw: unknown;
}

export interface CheckoutInput {
  tenantId: string;
  sku: string;
  userId: string;
}

export function createCheckout(deps: CheckoutDeps) {
  const guard = createTenantGuard();
  const tx = createTransactionRunner(deps.client as never);

  return async function checkout(input: CheckoutInput) {
    return runWithTenant(input.tenantId, async () => {
      return tx(async (session) => {
        const orders = guard.wrap(deps.ordersRaw as never);
        const stock = guard.wrap(deps.stockRaw as never);

        // Guarded findOne: filter is forced to include tenantId by the guard.
        const item = (await (stock as never as { findOne: (f: unknown, o?: unknown) => Promise<unknown> }).findOne(
          { sku: input.sku },
          { session },
        )) as { qty?: number } | null;

        if (!item || (item.qty ?? 0) < 1) {
          throw new Error("Out of stock");
        }

        await (stock as never as { updateOne: (f: unknown, u: unknown, o?: unknown) => Promise<unknown> }).updateOne(
          { sku: input.sku },
          { $inc: { qty: -1 } },
          { session },
        );

        const order = { sku: input.sku, userId: input.userId, createdAt: new Date().toISOString() };
        await (orders as never as { insertOne: (d: unknown, o?: unknown) => Promise<unknown> }).insertOne(order, { session });
        return order;
      });
    });
  };
}
