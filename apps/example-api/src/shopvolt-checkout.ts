/**
 * ShopVolt-style checkout, on MongoDB — NOT a rewrite of ShopVolt itself.
 *
 * ShopVolt's real backend (checked 2026-11-03) is NestJS + TypeORM +
 * PostgreSQL, so mongo-tenant-guard / mongo-transact cannot drop into
 * its existing Postgres checkout. This file mirrors ShopVolt's
 * OrdersService.createOrder flow on MongoDB collections, so the kit
 * is proven against a real multi-item store checkout, not just a
 * single-SKU example:
 *
 *   ShopVolt:  validate payment -> create order -> create order items
 *              -> mark payment as used
 *   Here:      same steps, plus tenant scoping and a transaction:
 *              payment validation, stock decrement per item, order +
 *              order items creation, payment marked used — all commit
 *              together, or none of them do.
 *
 * Collections (all tenant-guarded): stock, orders, order_items, payments.
 * A payment document looks like: { userId, amount, used: false, tenantId }
 * A stock document looks like: { productId, qty, tenantId }
 */
import { createTenantGuard, runWithTenant } from "../../../packages/tenant-guard/src/index";
import { createTransactionRunner } from "../../../packages/transact/src/index";

export interface ShopVoltDeps {
  client: { startSession: () => unknown };
  stockRaw: unknown;
  ordersRaw: unknown;
  orderItemsRaw: unknown;
  paymentsRaw: unknown;
}

export interface ShopVoltItem {
  productId: number;
  quantity: number;
  price: number;
}

export interface ShopVoltInput {
  tenantId: string;
  userId: number;
  items: ShopVoltItem[];
  shippingAddress: string;
  paymentMethod: string;
  paymentId: number;
}

type Coll = {
  findOne: (f: unknown, o?: unknown) => Promise<Record<string, unknown> | null>;
  updateOne: (f: unknown, u: unknown, o?: unknown) => Promise<unknown>;
  insertOne: (d: unknown, o?: unknown) => Promise<{ insertedId: unknown }>;
};

export function createShopVoltCheckout(deps: ShopVoltDeps) {
  const guard = createTenantGuard();
  const tx = createTransactionRunner(deps.client as never);

  return async function shopVoltCheckout(input: ShopVoltInput) {
    return runWithTenant(input.tenantId, async () => {
      return tx(async (session) => {
        const stock = guard.wrap(deps.stockRaw as never) as unknown as Coll;
        const orders = guard.wrap(deps.ordersRaw as never) as unknown as Coll;
        const orderItems = guard.wrap(deps.orderItemsRaw as never) as unknown as Coll;
        const payments = guard.wrap(deps.paymentsRaw as never) as unknown as Coll;

        const totalAmount = input.items.reduce((sum, item) => sum + item.price * item.quantity, 0);

        // 1. Validate payment: belongs to this user, correct total, not used yet.
        const payment = await payments.findOne({ id: input.paymentId, userId: input.userId }, { session });
        if (!payment) throw new Error("Payment not found");
        if (payment.used) throw new Error("Payment already used");
        if (payment.amount !== totalAmount) throw new Error("Payment amount does not match order total");

        // 2. Check and decrement stock for every item, before creating anything.
        for (const item of input.items) {
          const product = await stock.findOne({ productId: item.productId }, { session });
          if (!product || ((product.qty as number) ?? 0) < item.quantity) {
            throw new Error(`Out of stock for product ${item.productId}`);
          }
          await stock.updateOne(
            { productId: item.productId },
            { $inc: { qty: -item.quantity } },
            { session },
          );
        }

        // 3. Create the order, then its items.
        const orderNumber = `ORD-${Date.now()}`;
        const order = {
          userId: input.userId,
          orderNumber,
          totalAmount,
          status: "pending",
          shippingAddress: input.shippingAddress,
          paymentMethod: input.paymentMethod,
          paymentId: input.paymentId,
        };
        const inserted = await orders.insertOne(order, { session });
        const orderId = inserted.insertedId;
        for (const item of input.items) {
          await orderItems.insertOne(
            { orderId, productId: item.productId, quantity: item.quantity, price: item.price },
            { session },
          );
        }

        // 4. Mark the payment as used, last, inside the same transaction.
        await payments.updateOne({ id: input.paymentId }, { $set: { used: true } }, { session });

        return { message: "Order created successfully", orderNumber, orderId };
      });
    });
  };
}
