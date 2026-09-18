import { col, defineSchema, table } from './ddl'
import { diffSchema, Migrator, type SqlSession } from './migrate'
import { and, eq, from, gt, isNull, type Dialect } from './query'
import { defineTable, integer, text, timestamptz } from './schema'

const ISO4217 = /^[A-Z]{3}$/

export type Money = { readonly minor: number; readonly currency: string }

export function money(minor: number, currency: string): Money {
  if (!Number.isSafeInteger(minor)) throw new Error('Money minor units must be a safe integer')
  if (!ISO4217.test(currency)) throw new Error(`Invalid ISO 4217 currency: ${JSON.stringify(currency)}`)
  return { minor, currency }
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`Currency mismatch ${a.currency} vs ${b.currency}`)
  return money(a.minor + b.minor, a.currency)
}

export function allocateMoney(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) throw new Error('allocateMoney needs at least one weight')
  let sum = 0
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) throw new Error('Weights must be finite and non-negative')
    sum += weight
  }
  if (sum === 0) throw new Error('Weights must sum to a positive number')
  const exact = weights.map((weight) => (total.minor * weight) / sum)
  const shares = exact.map((value) => Math.trunc(value))
  let leftover = total.minor - shares.reduce((acc, share) => acc + share, 0)
  const order = exact
    .map((value, index) => ({ index, rem: Math.abs(value - (shares[index] ?? 0)) }))
    .sort((a, b) => b.rem - a.rem || a.index - b.index)
  const step = leftover > 0 ? 1 : leftover < 0 ? -1 : 0
  let cursor = 0
  while (leftover !== 0) {
    const index = order[cursor % order.length]?.index
    if (index === undefined) break
    shares[index] = (shares[index] ?? 0) + step
    leftover -= step
    cursor += 1
  }
  return shares.map((minor) => money(minor, total.currency))
}

export const catalogSchema = defineSchema({
  tenants: table({
    id: col.integer().primaryKey(),
    name: col.text(),
  }),
  categories: table({
    id: col.integer().primaryKey(),
    tenantId: col.integer().references('tenants', 'id', { onDelete: 'cascade' }),
    parentId: col.integer().nullable().references('categories', 'id', { onDelete: 'restrict' }),
    name: col.text(),
    deletedAt: col.timestamptz().nullable(),
  })
    .index('categories_tenant_id_uq', ['tenantId', 'id'], { unique: true })
    .index('categories_tenant_parent_idx', ['tenantId', 'parentId']),
  category_tree: table({
    tenantId: col.integer().references('tenants', 'id', { onDelete: 'cascade' }),
    ancestorId: col.integer().references('categories', 'id', { onDelete: 'cascade' }),
    descendantId: col.integer().references('categories', 'id', { onDelete: 'cascade' }),
    depth: col.integer(),
  })
    .index('category_tree_edge_uq', ['tenantId', 'ancestorId', 'descendantId'], { unique: true })
    .index('category_tree_desc_idx', ['tenantId', 'descendantId']),
  products: table({
    id: col.integer().primaryKey(),
    tenantId: col.integer().references('tenants', 'id', { onDelete: 'cascade' }),
    categoryId: col.integer().references('categories', 'id', { onDelete: 'restrict' }),
    sku: col.text(),
    priceMinor: col.integer(),
    currency: col.text(),
    deletedAt: col.timestamptz().nullable(),
  })
    .index('products_tenant_id_uq', ['tenantId', 'id'], { unique: true })
    .index('products_tenant_category_idx', ['tenantId', 'categoryId']),
})

export const catalogLiveSkuIndex =
  'CREATE UNIQUE INDEX IF NOT EXISTS "products_live_sku_uq" ON "products" ("tenantId", "sku") WHERE "deletedAt" IS NULL'

export const tenants = defineTable('tenants', { id: integer(), name: text() })
export const categories = defineTable('categories', {
  id: integer(),
  tenantId: integer(),
  parentId: integer(),
  name: text(),
  deletedAt: timestamptz(),
})
export const categoryTree = defineTable('category_tree', {
  tenantId: integer(),
  ancestorId: integer(),
  descendantId: integer(),
  depth: integer(),
})
export const products = defineTable('products', {
  id: integer(),
  tenantId: integer(),
  categoryId: integer(),
  sku: text(),
  priceMinor: integer(),
  currency: text(),
  deletedAt: timestamptz(),
})

export function liveProductsQuery(tenantId: number) {
  return from(products)
    .where(and(eq(products.tenantId, tenantId), isNull(products.deletedAt)))
    .select({
      id: products.id,
      sku: products.sku,
      priceMinor: products.priceMinor,
      currency: products.currency,
      categoryId: products.categoryId,
    })
    .orderBy(products.id)
}

export function descendantsQuery(tenantId: number, ancestorId: number) {
  return from(categoryTree)
    .innerJoin(
      categories,
      and(eq(categories.id, categoryTree.descendantId), eq(categories.tenantId, categoryTree.tenantId)),
    )
    .where(
      and(
        eq(categoryTree.tenantId, tenantId),
        eq(categoryTree.ancestorId, ancestorId),
        gt(categoryTree.depth, 0),
        isNull(categories.deletedAt),
      ),
    )
    .select({ id: categories.id, name: categories.name, depth: categoryTree.depth })
    .orderBy(categoryTree.depth)
    .orderBy(categories.id)
}

export function applyCatalogSchema(session: SqlSession, dialect: Dialect): void {
  const empty = defineSchema({})
  new Migrator(session, dialect).migrateUp([
    { id: '001_catalog', up: diffSchema(empty, catalogSchema), down: diffSchema(catalogSchema, empty) },
  ])
  session.exec(catalogLiveSkuIndex)
}

export class Catalog {
  constructor(
    private readonly session: SqlSession,
    private readonly dialect: Dialect,
  ) {}

  private ph(n: number): string {
    return this.dialect === 'sqlite' ? '?' : `$${n}`
  }

  createTenant(id: number, name: string): void {
    this.session.exec(`INSERT INTO "tenants" ("id", "name") VALUES (${this.ph(1)}, ${this.ph(2)})`, [id, name])
  }

  createCategory(id: number, tenantId: number, name: string, parentId: number | null = null): void {
    if (parentId === id) throw new Error('Cycle: new parent is inside the subtree')
    if (parentId !== null) this.requireLiveCategory(tenantId, parentId)
    this.session.exec(
      `INSERT INTO "categories" ("id", "tenantId", "parentId", "name", "deletedAt") VALUES (${this.ph(1)}, ${this.ph(2)}, ${this.ph(3)}, ${this.ph(4)}, NULL)`,
      [id, tenantId, parentId, name],
    )
    this.session.exec(
      `INSERT INTO "category_tree" ("tenantId", "ancestorId", "descendantId", "depth") VALUES (${this.ph(1)}, ${this.ph(2)}, ${this.ph(3)}, 0)`,
      [tenantId, id, id],
    )
    if (parentId === null) return
    this.session.exec(
      `INSERT INTO "category_tree" ("tenantId", "ancestorId", "descendantId", "depth") SELECT "tenantId", "ancestorId", ${this.ph(1)}, "depth" + 1 FROM "category_tree" WHERE "tenantId" = ${this.ph(2)} AND "descendantId" = ${this.ph(3)} AND "depth" >= 0`,
      [id, tenantId, parentId],
    )
  }

  reparentCategory(tenantId: number, id: number, parentId: number | null): void {
    this.requireLiveCategory(tenantId, id)
    if (parentId !== null) this.requireLiveCategory(tenantId, parentId)
    const cycle = this.session.all(
      `SELECT 1 AS ok FROM "category_tree" WHERE "tenantId" = ${this.ph(1)} AND "ancestorId" = ${this.ph(2)} AND "descendantId" = ${this.ph(3)}`,
      [tenantId, id, parentId ?? id],
    )
    if (cycle[0]) throw new Error('Cycle: new parent is inside the subtree')
    // SQLite forbids reading category_tree in the same DELETE; wrap the subtree ids.
    this.session.exec(
      `DELETE FROM "category_tree" WHERE "tenantId" = ${this.ph(1)} AND "descendantId" IN (SELECT "descendantId" FROM (SELECT "descendantId" FROM "category_tree" WHERE "tenantId" = ${this.ph(2)} AND "ancestorId" = ${this.ph(3)})) AND "ancestorId" NOT IN (SELECT "descendantId" FROM (SELECT "descendantId" FROM "category_tree" WHERE "tenantId" = ${this.ph(4)} AND "ancestorId" = ${this.ph(5)}))`,
      [tenantId, tenantId, id, tenantId, id],
    )
    if (parentId !== null) {
      this.session.exec(
        `INSERT INTO "category_tree" ("tenantId", "ancestorId", "descendantId", "depth") SELECT a."tenantId", a."ancestorId", d."descendantId", a."depth" + d."depth" + 1 FROM "category_tree" a JOIN "category_tree" d ON a."tenantId" = d."tenantId" WHERE a."tenantId" = ${this.ph(1)} AND a."descendantId" = ${this.ph(2)} AND d."ancestorId" = ${this.ph(3)}`,
        [tenantId, parentId, id],
      )
    }
    this.session.exec(
      `UPDATE "categories" SET "parentId" = ${this.ph(1)} WHERE "tenantId" = ${this.ph(2)} AND "id" = ${this.ph(3)}`,
      [parentId, tenantId, id],
    )
  }

  descendants(tenantId: number, ancestorId: number): { id: number; name: string; depth: number }[] {
    const compiled = descendantsQuery(tenantId, ancestorId).compile(this.dialect)
    return this.session.all(compiled.sql, compiled.params).map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      depth: Number(row.depth),
    }))
  }

  createProduct(id: number, tenantId: number, categoryId: number, sku: string, price: Money): void {
    this.requireLiveCategory(tenantId, categoryId)
    this.session.exec(
      `INSERT INTO "products" ("id", "tenantId", "categoryId", "sku", "priceMinor", "currency", "deletedAt") VALUES (${this.ph(1)}, ${this.ph(2)}, ${this.ph(3)}, ${this.ph(4)}, ${this.ph(5)}, ${this.ph(6)}, NULL)`,
      [id, tenantId, categoryId, sku, price.minor, price.currency],
    )
  }

  softDeleteProduct(tenantId: number, id: number): void {
    const n = this.session.all(
      `UPDATE "products" SET "deletedAt" = ${this.ph(1)} WHERE "tenantId" = ${this.ph(2)} AND "id" = ${this.ph(3)} AND "deletedAt" IS NULL RETURNING "id"`,
      [new Date().toISOString(), tenantId, id],
    )
    if (!n[0]) throw new Error(`Live product ${id} not found in tenant ${tenantId}`)
  }

  restoreProduct(tenantId: number, id: number): void {
    const n = this.session.all(
      `UPDATE "products" SET "deletedAt" = NULL WHERE "tenantId" = ${this.ph(1)} AND "id" = ${this.ph(2)} AND "deletedAt" IS NOT NULL RETURNING "id"`,
      [tenantId, id],
    )
    if (!n[0]) throw new Error(`Deleted product ${id} not found in tenant ${tenantId}`)
  }

  liveProducts(tenantId: number): { id: number; sku: string; price: Money; categoryId: number }[] {
    const compiled = liveProductsQuery(tenantId).compile(this.dialect)
    return this.session.all(compiled.sql, compiled.params).map((row) => ({
      id: Number(row.id),
      sku: String(row.sku),
      categoryId: Number(row.categoryId),
      price: money(Number(row.priceMinor), String(row.currency)),
    }))
  }

  totalLivePrice(tenantId: number, currency: string): Money {
    money(0, currency)
    return this.liveProducts(tenantId)
      .filter((row) => row.price.currency === currency)
      .reduce((sum, row) => addMoney(sum, row.price), money(0, currency))
  }

  softDeleteCategory(tenantId: number, id: number): void {
    this.requireLiveCategory(tenantId, id)
    if (this.descendants(tenantId, id).length > 0) throw new Error('Cannot delete a category that still has live descendants')
    const productsHere = this.liveProducts(tenantId).filter((row) => row.categoryId === id)
    if (productsHere.length > 0) throw new Error('Cannot delete a category that still has live products')
    const n = this.session.all(
      `UPDATE "categories" SET "deletedAt" = ${this.ph(1)} WHERE "tenantId" = ${this.ph(2)} AND "id" = ${this.ph(3)} AND "deletedAt" IS NULL RETURNING "id"`,
      [new Date().toISOString(), tenantId, id],
    )
    if (!n[0]) throw new Error(`Live category ${id} not found in tenant ${tenantId}`)
  }

  private requireLiveCategory(tenantId: number, id: number): void {
    const row = this.session.all(
      `SELECT "deletedAt" FROM "categories" WHERE "tenantId" = ${this.ph(1)} AND "id" = ${this.ph(2)}`,
      [tenantId, id],
    )[0]
    if (!row) throw new Error(`Category ${id} not found in tenant ${tenantId}`)
    if (row.deletedAt != null) throw new Error(`Category ${id} is deleted`)
  }
}
