import { expect, test } from 'vitest'
import {
  addMoney,
  allocateMoney,
  applyCatalogSchema,
  Catalog,
  catalogLiveSkuIndex,
  catalogSchema,
  compileOps,
  defineSchema,
  diffSchema,
  liveProductsQuery,
  money,
  type SqlSession,
} from '../src/index'

type SqliteDb = {
  exec: (sql: string) => void
  prepare: (sql: string) => { all: (...p: unknown[]) => unknown; run: (...p: unknown[]) => unknown }
  close: () => void
}

function sqlite(): { session: SqlSession; catalog: Catalog; close: () => void } {
  const loaded = (
    globalThis as { process?: { getBuiltinModule?: (id: string) => { DatabaseSync: new (path: string) => SqliteDb } } }
  ).process?.getBuiltinModule?.('node:sqlite')
  if (!loaded) throw new Error('node:sqlite is not available in this runtime')
  const db = new loaded.DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const session: SqlSession = {
    exec: (sql, params) => (!params || params.length === 0 ? db.exec(sql) : db.prepare(sql).run(...params)),
    all: (sql, params) => db.prepare(sql).all(...(params ?? [])) as Record<string, unknown>[],
  }
  applyCatalogSchema(session, 'sqlite')
  return { session, catalog: new Catalog(session, 'sqlite'), close: () => db.close() }
}

test('schema uses composite tenant identity; live SKU uniqueness is a partial index', () => {
  const sql = compileOps(diffSchema(defineSchema({}), catalogSchema), 'sqlite').join('\n')
  expect(sql).toContain('CREATE UNIQUE INDEX "categories_tenant_id_uq" ON "categories" ("tenantId", "id")')
  expect(sql).toContain('CREATE UNIQUE INDEX "products_tenant_id_uq" ON "products" ("tenantId", "id")')
  expect(sql).toContain('CREATE UNIQUE INDEX "category_tree_edge_uq" ON "category_tree" ("tenantId", "ancestorId", "descendantId")')
  expect(sql).toContain('FOREIGN KEY ("parentId") REFERENCES "categories" ("id") ON DELETE RESTRICT')
  expect(catalogLiveSkuIndex).toContain('WHERE "deletedAt" IS NULL')
  const compiled = liveProductsQuery(7).compile('sqlite')
  expect(compiled.sql).toContain('"deletedAt" IS NULL')
  expect(compiled.sql).not.toMatch(/"deletedAt" = /)
  expect(compiled.params[0]).toBe(7)
})

test('money is integer minor units; allocate uses largest remainder', () => {
  expect(() => money(1.5, 'USD')).toThrow(/safe integer/)
  expect(() => money(1, 'usd')).toThrow(/ISO 4217/)
  expect(() => money(1, 'US')).toThrow(/ISO 4217/)
  expect(() => addMoney(money(1, 'USD'), money(1, 'EUR'))).toThrow(/mismatch/)
  expect(addMoney(money(40, 'USD'), money(2, 'USD'))).toEqual({ minor: 42, currency: 'USD' })
  expect(() => addMoney(money(Number.MAX_SAFE_INTEGER, 'USD'), money(1, 'USD'))).toThrow(/safe integer/)
  expect(allocateMoney(money(100, 'USD'), [1, 1, 1]).map((part) => part.minor)).toEqual([34, 33, 33])
  expect(allocateMoney(money(1, 'JPY'), [1, 1, 1]).map((part) => part.minor)).toEqual([1, 0, 0])
  expect(allocateMoney(money(-5, 'USD'), [1, 1]).map((part) => part.minor)).toEqual([-3, -2])
  expect(() => allocateMoney(money(10, 'USD'), [])).toThrow(/at least one/)
  expect(() => allocateMoney(money(10, 'USD'), [0, 0])).toThrow(/positive/)
  expect(() => allocateMoney(money(10, 'USD'), [-1])).toThrow(/non-negative/)
})

test('lookups are (tenantId, id); a foreign category is not found', () => {
  const db = sqlite()
  db.catalog.createTenant(1, 'acme')
  db.catalog.createTenant(2, 'other')
  db.catalog.createCategory(10, 1, 'root')
  db.catalog.createCategory(11, 2, 'root')
  expect(() => db.catalog.createCategory(12, 1, 'stolen', 11)).toThrow(/not found in tenant 1/)
  expect(() => db.catalog.createProduct(1, 1, 11, 'SKU-1', money(100, 'USD'))).toThrow(/not found in tenant 1/)
  db.catalog.createProduct(1, 1, 10, 'SKU-1', money(100, 'USD'))
  expect(db.catalog.liveProducts(2)).toEqual([])
  expect(db.catalog.liveProducts(1).map((row) => row.sku)).toEqual(['SKU-1'])
  db.close()
})

test('closure table descendants, reparent, and cycle detection stay inside the tenant', () => {
  const db = sqlite()
  db.catalog.createTenant(1, 'acme')
  db.catalog.createTenant(2, 'other')
  db.catalog.createCategory(1, 1, 'root')
  db.catalog.createCategory(2, 1, 'a', 1)
  db.catalog.createCategory(3, 1, 'b', 2)
  db.catalog.createCategory(4, 1, 'c', 1)
  db.catalog.createCategory(20, 2, 'noise')
  expect(db.catalog.descendants(1, 1).map((row) => row.id)).toEqual([2, 4, 3])
  expect(db.catalog.descendants(1, 2).map((row) => ({ id: row.id, depth: row.depth }))).toEqual([{ id: 3, depth: 1 }])
  expect(db.catalog.descendants(2, 1)).toEqual([])
  expect(() => db.catalog.reparentCategory(1, 1, 3)).toThrow(/Cycle/)
  expect(() => db.catalog.reparentCategory(1, 2, 2)).toThrow(/Cycle/)
  db.catalog.reparentCategory(1, 2, 4)
  expect(db.catalog.descendants(1, 4).map((row) => row.id)).toEqual([2, 3])
  expect(db.catalog.descendants(1, 1).map((row) => row.id)).toEqual([4, 2, 3])
  expect(db.catalog.descendants(1, 2).map((row) => row.id)).toEqual([3])
  db.close()
})

test('soft-delete hides live rows, frees the SKU, and blocks restore on a taken SKU', () => {
  const db = sqlite()
  db.catalog.createTenant(1, 'acme')
  db.catalog.createCategory(1, 1, 'root')
  db.catalog.createProduct(1, 1, 1, 'SKU-1', money(50, 'USD'))
  db.catalog.createProduct(2, 1, 1, 'SKU-2', money(70, 'EUR'))
  expect(() => db.catalog.createProduct(3, 1, 1, 'SKU-1', money(1, 'USD'))).toThrow(/UNIQUE|unique/)
  expect(db.catalog.totalLivePrice(1, 'USD')).toEqual({ minor: 50, currency: 'USD' })
  db.catalog.softDeleteProduct(1, 1)
  expect(db.catalog.liveProducts(1).map((row) => row.sku)).toEqual(['SKU-2'])
  db.catalog.createProduct(3, 1, 1, 'SKU-1', money(10, 'USD'))
  expect(() => db.catalog.restoreProduct(1, 1)).toThrow(/UNIQUE|unique/)
  expect(() => db.catalog.softDeleteCategory(1, 1)).toThrow(/live products/)
  db.catalog.softDeleteProduct(1, 2)
  db.catalog.softDeleteProduct(1, 3)
  db.catalog.createCategory(2, 1, 'child', 1)
  expect(() => db.catalog.softDeleteCategory(1, 1)).toThrow(/live descendants/)
  db.catalog.softDeleteCategory(1, 2)
  db.catalog.softDeleteCategory(1, 1)
  expect(() => db.catalog.createProduct(4, 1, 1, 'SKU-9', money(1, 'USD'))).toThrow(/deleted/)
  db.close()
})
