export type TenantId = string;

export interface GuardOptions {
  /** Field name that carries the tenant. Default: "tenantId". */
  tenantField?: string;
  /**
   * Collections that are genuinely shared across tenants (e.g. "countries").
   * These bypass tenant filtering. Keep this list as short as possible, and
   * never put user data in a global collection.
   */
  globalCollections?: string[];
}

/** Minimal MongoDB collection shape. The real driver Collection satisfies this structurally for the methods used here. */
export interface GuardedCollectionLike {
  find(filter?: Record<string, unknown>, options?: Record<string, unknown>): unknown;
  findOne(filter?: Record<string, unknown>, options?: Record<string, unknown>): unknown;
  insertOne(doc: Record<string, unknown>, options?: Record<string, unknown>): unknown;
  insertMany(docs: Record<string, unknown>[], options?: Record<string, unknown>): unknown;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>): unknown;
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>): unknown;
  deleteOne(filter: Record<string, unknown>, options?: Record<string, unknown>): unknown;
  deleteMany(filter: Record<string, unknown>, options?: Record<string, unknown>): unknown;
  countDocuments(filter?: Record<string, unknown>, options?: Record<string, unknown>): unknown;
  aggregate(pipeline: Record<string, unknown>[], options?: Record<string, unknown>): unknown;
  collectionName?: string;
}
