import { runWithTenant } from "./context";
import type { TenantId } from "./types";

export interface TenantRequest {
  headers?: Record<string, string | string[] | undefined>;
  user?: { tenantId?: string };
  // Allow any other Express request fields without importing express.
  [key: string]: unknown;
}

export interface TenantResponse {
  status(code: number): { json(body: unknown): unknown };
  json(body: unknown): unknown;
}

export type TenantNext = (error?: unknown) => void;

/**
 * Express middleware that sets the tenant for the whole request.
 *
 * getTenantId is YOUR auth logic: read it from req.user after JWT / session
 * auth, never trust a raw client-supplied header in production unless you
 * have verified it. If it returns nothing, the request continues, but any
 * guarded query will throw TenantRequiredError — fail-closed, not silent.
 *
 * Example:
 *   app.use(tenantMiddleware({ getTenantId: (req) => req.user?.tenantId }));
 */
export function tenantMiddleware(options: {
  getTenantId: (req: TenantRequest) => TenantId | undefined;
}) {
  return (req: TenantRequest, _res: TenantResponse, next: TenantNext) => {
    const tenantId = options.getTenantId(req);
    if (!tenantId) {
      next();
      return;
    }
    // runWithTenant keeps the tenant scoped to this request's async chain.
    // Express 4/5: calling next() inside run() preserves the context for
    // downstream handlers in the same request.
    runWithTenant(tenantId, () => next());
  };
}

/** Map guard errors to HTTP responses in an Express error handler. */
export function tenantErrorHandler(
  error: unknown,
  _req: TenantRequest,
  res: TenantResponse,
  next: TenantNext,
): void {
  if (error instanceof Error && error.name === "TenantRequiredError") {
    res.status(403).json({ error: "Tenant is required for this operation." });
    return;
  }
  if (error instanceof Error && error.name === "TenantMismatchError") {
    res.status(403).json({ error: "Operation crosses tenant boundaries and was blocked." });
    return;
  }
  next(error);
}
