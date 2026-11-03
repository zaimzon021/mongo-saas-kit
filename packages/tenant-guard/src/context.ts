import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantId } from "./types";

/**
 * Tenant context, carried per-request with AsyncLocalStorage.
 *
 * Why AsyncLocalStorage and not a global variable? A global would leak
 * Tenant A's id into Tenant B's request when requests run concurrently.
 * AsyncLocalStorage scopes the value to the current async execution, so
 * each Express request keeps its own tenant.
 */
const storage = new AsyncLocalStorage<TenantId>();

export function getTenantId(): TenantId | undefined {
  return storage.getStore();
}

export function runWithTenant<T>(tenantId: TenantId, fn: () => Promise<T> | T): Promise<T> | T {
  if (!tenantId || typeof tenantId !== "string") {
    throw new Error("runWithTenant requires a non-empty string tenantId");
  }
  return storage.run(tenantId, fn);
}
