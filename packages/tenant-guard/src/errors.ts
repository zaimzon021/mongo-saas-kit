export class TenantGuardError extends Error {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "TenantGuardError";
    this.cause = cause;
  }
}

/** Thrown when a guarded operation runs with no tenant in context. Fail-closed: no query runs. */
export class TenantRequiredError extends TenantGuardError {
  constructor(collection: string) {
    super(
      `Tenant is required for collection "${collection}", but no tenant is in context. ` +
        `Use runWithTenant(), tenantMiddleware(), or wrapCollection(collection, tenantId). ` +
        `This query was NOT executed.`,
    );
    this.name = "TenantRequiredError";
  }
}

/** Thrown when a caller tries to read/write another tenant's data, or change a document's tenant. */
export class TenantMismatchError extends TenantGuardError {
  constructor(collection: string, detail: string) {
    super(`Tenant mismatch on collection "${collection}": ${detail}. This operation was NOT executed.`);
    this.name = "TenantMismatchError";
  }
}
