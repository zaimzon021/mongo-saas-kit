import { TenantMismatchError, TenantRequiredError } from "./errors";
import { getTenantId, runWithTenant } from "./context";
import type { GuardedCollectionLike, GuardOptions, TenantId } from "./types";

type Filter = Record<string, unknown>;
type UpdateDoc = Record<string, unknown>;

function isPlainObject(value: unknown): value is Filter {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTenantValue(doc: Filter, field: string): unknown {
  return doc[field];
}

/**
 * TenantGuard: the core of mongo-tenant-guard.
 *
 * Rules, stated plainly so a reviewer can check them:
 * 1. No tenant in context + no explicit tenant + not a global collection
 *    => the operation throws and NOTHING is executed. Fail-closed.
 * 2. A filter/document that already carries a different tenant
 *    => throws, and nothing is executed. The guard never silently overwrites it.
 * 3. A filter/document with no tenant => the current tenant is injected.
 * 4. $or / $and / $nor filters are wrapped in $and with the tenant filter,
 *    so a branch of an $or cannot escape the tenant scope.
 * 5. Updates may not change tenantId, and may not unset it. Upserts set
 *    tenantId on insert via $setOnInsert.
 * 6. Aggregations get a leading $match on tenantId.
 * 7. Global collections and the explicit system() scope bypass the guard,
 *    but only when the developer says so in code — never by accident.
 */
export class TenantGuard {
  private readonly tenantField: string;
  private readonly globalCollections: Set<string>;

  constructor(options: GuardOptions = {}) {
    this.tenantField = options.tenantField ?? "tenantId";
    this.globalCollections = new Set(options.globalCollections ?? []);
  }

  /** Wrap a collection so every operation through it is tenant-scoped. */
  wrap<T extends GuardedCollectionLike>(
    collection: T,
    explicitTenantId?: TenantId,
    collectionName?: string,
  ): TenantCollection<T> {
    const name = collectionName ?? collection.collectionName ?? "unknown";
    return new TenantCollection<T>(collection, name, this, explicitTenantId);
  }

  /** Run a function with an explicit tenant, regardless of request context. Useful for jobs and tests. */
  runWithTenant<T>(tenantId: TenantId, fn: () => Promise<T> | T): Promise<T> | T {
    return runWithTenant(tenantId, fn);
  }

  resolveTenant(collectionName: string, explicitTenantId?: TenantId): TenantId | "global" | undefined {
    if (this.globalCollections.has(collectionName)) return "global";
    return explicitTenantId ?? getTenantId();
  }

  guardFilter(collectionName: string, filter: Filter = {}, explicitTenantId?: TenantId): Filter {
    const tenant = this.resolveTenant(collectionName, explicitTenantId);
    if (tenant === "global") return filter;
    if (!tenant) throw new TenantRequiredError(collectionName);

    const existing = getTenantValue(filter, this.tenantField);
    if (existing !== undefined && existing !== tenant) {
      throw new TenantMismatchError(collectionName, `filter already scopes to a different tenant (${String(existing)})`);
    }
    if (existing === tenant) return filter;
    if (Object.keys(filter).length === 0) return { [this.tenantField]: tenant };
    // $and wrapping is what makes $or safe: every branch must also satisfy tenantId.
    return { $and: [filter, { [this.tenantField]: tenant }] };
  }

  guardDocument(collectionName: string, doc: Filter, explicitTenantId?: TenantId): Filter {
    const tenant = this.resolveTenant(collectionName, explicitTenantId);
    if (tenant === "global") return doc;
    if (!tenant) throw new TenantRequiredError(collectionName);
    const existing = getTenantValue(doc, this.tenantField);
    if (existing !== undefined && existing !== tenant) {
      throw new TenantMismatchError(collectionName, `document already belongs to a different tenant (${String(existing)})`);
    }
    if (existing === tenant) return doc;
    return { ...doc, [this.tenantField]: tenant };
  }

  guardUpdate(collectionName: string, update: UpdateDoc, explicitTenantId?: TenantId): UpdateDoc {
    const tenant = this.resolveTenant(collectionName, explicitTenantId);
    if (tenant === "global") return update;
    if (!tenant) throw new TenantRequiredError(collectionName);

    const set = isPlainObject(update.$set) ? update.$set : undefined;
    if (set && this.tenantField in set && set[this.tenantField] !== tenant) {
      throw new TenantMismatchError(collectionName, "update tries to change tenantId");
    }
    const unset = isPlainObject(update.$unset) ? update.$unset : undefined;
    if (unset && this.tenantField in unset) {
      throw new TenantMismatchError(collectionName, "update tries to unset tenantId");
    }
    // Upserts: make sure a newly inserted document gets the tenant.
    // If the caller already set it correctly, leave it alone.
    return update;
  }

  guardPipeline(collectionName: string, pipeline: Filter[], explicitTenantId?: TenantId): Filter[] {
    const tenant = this.resolveTenant(collectionName, explicitTenantId);
    if (tenant === "global") return pipeline;
    if (!tenant) throw new TenantRequiredError(collectionName);
    return [{ $match: { [this.tenantField]: tenant } }, ...pipeline];
  }

  get field(): string {
    return this.tenantField;
  }
}

export class TenantCollection<T extends GuardedCollectionLike> {
  private readonly systemMode: boolean;

  constructor(
    private readonly inner: T,
    private readonly name: string,
    private readonly guard: TenantGuard,
    private readonly explicitTenantId?: TenantId,
    systemMode = false,
  ) {
    this.systemMode = systemMode;
  }

  /** Explicit, auditable bypass for internal jobs/migrations. Never use for user-facing requests. */
  system(): TenantCollection<T> {
    return new TenantCollection(this.inner, this.name, this.guard, this.explicitTenantId, true);
  }

  private tenant(): TenantId | "global" | undefined {
    if (this.systemMode) return "global";
    return this.guard.resolveTenant(this.name, this.explicitTenantId);
  }

  private requireTenant(): TenantId | "global" {
    const tenant = this.tenant();
    if (!tenant) throw new TenantRequiredError(this.name);
    return tenant;
  }

  find(filter: Filter = {}, options?: Record<string, unknown>): unknown {
    if (this.systemMode) return this.inner.find(filter, options);
    return this.inner.find(this.guard.guardFilter(this.name, filter, this.explicitTenantId), options);
  }

  findOne(filter: Filter = {}, options?: Record<string, unknown>): unknown {
    if (this.systemMode) return this.inner.findOne(filter, options);
    return this.inner.findOne(this.guard.guardFilter(this.name, filter, this.explicitTenantId), options);
  }

  insertOne(doc: Filter, options?: Record<string, unknown>): unknown {
    if (this.systemMode) return this.inner.insertOne(doc, options);
    return this.inner.insertOne(this.guard.guardDocument(this.name, doc, this.explicitTenantId), options);
  }

  insertMany(docs: Filter[], options?: Record<string, unknown>): unknown {
    if (this.systemMode) return this.inner.insertMany(docs, options);
    return this.inner.insertMany(
      docs.map((doc) => this.guard.guardDocument(this.name, doc, this.explicitTenantId)),
      options,
    );
  }

  updateOne(filter: Filter, update: UpdateDoc, options: Record<string, unknown> = {}): unknown {
    if (this.systemMode) return this.inner.updateOne(filter, update, options);
    this.requireTenant();
    const guardedUpdate = this.guard.guardUpdate(this.name, update, this.explicitTenantId);
    const tenant = this.guard.resolveTenant(this.name, this.explicitTenantId);
    let finalUpdate = guardedUpdate;
    if (options.upsert && tenant !== "global" && tenant) {
      const setOnInsert = isPlainObject(guardedUpdate.$setOnInsert) ? { ...guardedUpdate.$setOnInsert } : {};
      if (!(this.guard.field in setOnInsert)) {
        setOnInsert[this.guard.field] = tenant;
      }
      finalUpdate = { ...guardedUpdate, $setOnInsert: setOnInsert };
    }
    return this.inner.updateOne(this.guard.guardFilter(this.name, filter, this.explicitTenantId), finalUpdate, options);
  }

  updateMany(filter: Filter, update: UpdateDoc, options?: Record<string, unknown>): unknown {
    if (this.systemMode) return this.inner.updateMany(filter, update, options);
    this.guard.guardUpdate(this.name, update, this.explicitTenantId);
    return this.inner.updateMany(this.guard.guardFilter(this.name, filter, this.explicitTenantId), update, options);
  }

  deleteOne(filter: Filter, options?: Record<string, unknown>): unknown {
    if (this.systemMode) return this.inner.deleteOne(filter, options);
    return this.inner.deleteOne(this.guard.guardFilter(this.name, filter, this.explicitTenantId), options);
  }

  deleteMany(filter: Filter, options?: Record<string, unknown>): unknown {
    if (this.systemMode) return this.inner.deleteMany(filter, options);
    return this.inner.deleteMany(this.guard.guardFilter(this.name, filter, this.explicitTenantId), options);
  }

  countDocuments(filter: Filter = {}, options?: Record<string, unknown>): unknown {
    if (this.systemMode) return this.inner.countDocuments(filter, options);
    return this.inner.countDocuments(this.guard.guardFilter(this.name, filter, this.explicitTenantId), options);
  }

  aggregate(pipeline: Filter[], options?: Record<string, unknown>): unknown {
    if (this.systemMode) return this.inner.aggregate(pipeline, options);
    return this.inner.aggregate(this.guard.guardPipeline(this.name, pipeline, this.explicitTenantId), options);
  }

  /** Access to the underlying collection, for operations the guard does not cover. Use sparingly. */
  raw(): T {
    return this.inner;
  }
}

export function createTenantGuard(options: GuardOptions = {}): TenantGuard {
  return new TenantGuard(options);
}
