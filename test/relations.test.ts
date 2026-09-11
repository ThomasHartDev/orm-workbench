import { expect, expectTypeOf, test } from 'vitest'
import {
  alias, belongsTo, defineTable, eagerBelongsTo, eagerHasMany, hasMany, integer,
  nestBelongsTo, nestHasMany, relatedQuery, text, uniqueKeys, type SqlSession,
} from '../src/index'

const users = defineTable('users', { id: integer(), email: text() })
const orders = defineTable('orders', { id: integer(), userId: integer(), sku: text() })
const people = defineTable('people', { id: integer(), managerId: integer(), name: text() })

const userOrders = hasMany('orders', users, orders, users.id, orders.userId)
const orderUser = belongsTo('user', orders, users, orders.userId, users.id)
const reports = alias(people, 'reports')
const managerReports = hasMany('reports', people, reports, people.id, reports.managerId)

const childSelect = { id: orders.id, userId: orders.userId, sku: orders.sku }
const parentSelect = { id: users.id, email: users.email }

type SqliteDb = {
  exec: (sql: string) => void
  prepare: (sql: string) => { all: (...p: unknown[]) => unknown; run: (...p: unknown[]) => unknown }
  close: () => void
}

function sqlite(): { session: SqlSession; queries: () => number; close: () => void } {
  const loaded = (
    globalThis as { process?: { getBuiltinModule?: (id: string) => { DatabaseSync: new (path: string) => SqliteDb } } }
  ).process?.getBuiltinModule?.('node:sqlite')
  if (!loaded) throw new Error('node:sqlite is not available in this runtime')
  const db = new loaded.DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE "users" ("id" INTEGER PRIMARY KEY, "email" TEXT NOT NULL);
    CREATE TABLE "orders" ("id" INTEGER PRIMARY KEY, "userId" INTEGER, "sku" TEXT NOT NULL);
    CREATE TABLE "people" ("id" INTEGER PRIMARY KEY, "managerId" INTEGER, "name" TEXT NOT NULL);
    INSERT INTO "users" ("id", "email") VALUES (1, 'a@x'), (2, 'b@x'), (3, 'c@x');
    INSERT INTO "orders" ("id", "userId", "sku") VALUES (10, 1, 'red'), (11, 1, 'blue'), (12, 2, 'green');
    INSERT INTO "people" ("id", "managerId", "name") VALUES (1, NULL, 'pat'), (2, 1, 'lee'), (3, 1, 'sam'), (4, 2, 'kim');
  `)
  let queries = 0
  const session: SqlSession = {
    exec: (sql, params) => {
      queries += 1
      if (!params || params.length === 0) db.exec(sql)
      else db.prepare(sql).run(...params)
    },
    all: (sql, params) => {
      queries += 1
      return db.prepare(sql).all(...(params ?? [])) as Record<string, unknown>[]
    },
  }
  return { session, queries: () => queries, close: () => db.close() }
}

test('relatedQuery batches unique keys into one IN list and skips nulls', () => {
  const compiled = relatedQuery(userOrders, [1, 1, null, 2, undefined], childSelect)
  expect(compiled.sql.split('\n')).toEqual([
    'SELECT "orders"."id" AS "id", "orders"."userId" AS "userId", "orders"."sku" AS "sku"',
    'FROM "orders" AS "orders"',
    'WHERE "orders"."userId" IN ($1, $2)',
  ])
  expect(compiled.params).toEqual([1, 2])
  const empty = relatedQuery(orderUser, [], parentSelect, { dialect: 'sqlite' })
  expect(empty.sql).toContain('WHERE 1 = 0')
  expect(empty.params).toEqual([])
  expect(empty.sql).not.toMatch(/\$\d/)
})

test('hasMany nests children, empty parents get [], orphans are dropped', () => {
  const parents = [{ id: 1, email: 'a@x' }, { id: 3, email: 'c@x' }, { id: 1, email: 'a-again' }]
  const children = [
    { id: 11, userId: 1, sku: 'blue' },
    { id: 10, userId: 1, sku: 'red' },
    { id: 99, userId: 9, sku: 'ghost' },
  ]
  const nested = nestHasMany(userOrders, parents, children)
  expect(nested[0]?.orders.map((row) => row.sku)).toEqual(['blue', 'red'])
  expect(nested[1]?.orders).toEqual([])
  expect(nested[2]?.orders.map((row) => row.sku)).toEqual(['blue', 'red'])
  expect(nested[0]?.orders).not.toBe(nested[2]?.orders)
  nested[0]?.orders.push({ id: 0, userId: 1, sku: 'x' })
  expect(nested[2]?.orders).toHaveLength(2)
})

test('belongsTo uses an identity map and leaves missing/null FKs as null', () => {
  const parents = [{ id: 1, email: 'a@x' }, { id: 1, email: 'dup' }, { id: 2, email: 'b@x' }]
  const children = [
    { id: 10, userId: 1, sku: 'red' },
    { id: 11, userId: 1, sku: 'blue' },
    { id: 12, userId: null, sku: 'anon' },
    { id: 13, userId: 9, sku: 'ghost' },
  ]
  const nested = nestBelongsTo(orderUser, children, parents)
  expect(nested[0]?.user?.email).toBe('a@x')
  expect(nested[1]?.user).toBe(nested[0]?.user)
  expect(nested[2]?.user).toBeNull()
  expect(nested[3]?.user).toBeNull()
})

test('eager hasMany is two queries against N+1, including a parent with no children', () => {
  const db = sqlite()
  try {
    const parents = db.session.all('SELECT "id", "email" FROM "users" ORDER BY "id"')
    const n1Start = db.queries()
    for (const parent of parents) {
      db.session.all('SELECT "id", "userId", "sku" FROM "orders" WHERE "userId" = ?', [parent.id])
    }
    expect(db.queries() - n1Start).toBe(parents.length)

    const eagerStart = db.queries()
    const graph = eagerHasMany(db.session, userOrders, parents, childSelect, {
      dialect: 'sqlite',
      orderBy: orders.id,
    })
    expect(db.queries() - eagerStart).toBe(1)
    expect(graph.map((row) => row.orders.map((order) => order.sku))).toEqual([['red', 'blue'], ['green'], []])
    expectTypeOf(graph[0]!.orders[0]!.sku).toEqualTypeOf<string>()
  } finally {
    db.close()
  }
})

test('eager belongsTo loads unique parents once; empty and all-null skip the second query', () => {
  const db = sqlite()
  try {
    const children = db.session.all('SELECT "id", "userId", "sku" FROM "orders" ORDER BY "id"')
    const start = db.queries()
    const graph = eagerBelongsTo(db.session, orderUser, children, parentSelect, { dialect: 'sqlite' })
    expect(db.queries() - start).toBe(1)
    expect(graph.map((row) => row.user?.email ?? null)).toEqual(['a@x', 'a@x', 'b@x'])
    expect(graph[0]?.user).toBe(graph[1]?.user)

    const skipped = db.queries()
    expect(eagerHasMany(db.session, userOrders, [], childSelect, { dialect: 'sqlite' })).toEqual([])
    expect(eagerBelongsTo(db.session, orderUser, [{ id: 1, userId: null, sku: 'z' }], parentSelect, { dialect: 'sqlite' })[0]?.user).toBeNull()
    expect(db.queries()).toBe(skipped)
  } finally {
    db.close()
  }
})

test('self-relation hasMany groups through an alias; uniqueKeys drops nulls', () => {
  const db = sqlite()
  try {
    const managers = db.session.all('SELECT "id", "managerId", "name" FROM "people" ORDER BY "id"')
    const graph = eagerHasMany(
      db.session,
      managerReports,
      managers,
      { id: reports.id, managerId: reports.managerId, name: reports.name },
      { dialect: 'sqlite', orderBy: reports.id },
    )
    expect(graph.find((row) => row.name === 'pat')?.reports.map((row) => row.name)).toEqual(['lee', 'sam'])
    expect(graph.find((row) => row.name === 'lee')?.reports.map((row) => row.name)).toEqual(['kim'])
    expect(graph.find((row) => row.name === 'kim')?.reports).toEqual([])
  } finally {
    db.close()
  }
  expect(uniqueKeys([null, 1, undefined, 1, 2])).toEqual([1, 2])
  expect(uniqueKeys([])).toEqual([])
})

test('relation declarations and nest/load reject mismatched columns and missing keys', () => {
  expect(() => hasMany('email', users, orders, users.id, orders.userId)).toThrow(/collides/)
  expect(() => belongsTo('user', orders, users, orders.sku, users.id)).toThrow(/differ/)
  expect(() => hasMany('orders', users, orders, users.email, orders.userId)).toThrow(/differ/)
  expect(() => hasMany('orders', users, orders, orders.userId, orders.userId)).toThrow(/not on/)
  expect(() => relatedQuery(userOrders, [1], { id: orders.id, sku: orders.sku })).toThrow(/project/)
  expect(() => relatedQuery(userOrders, [1], childSelect, { orderBy: users.id })).toThrow(/orderBy/)
  expect(() => nestHasMany(userOrders, [{ email: 'a@x' }], [])).toThrow(/missing/)
  expect(() => nestBelongsTo(orderUser, [{ id: 1, sku: 'x' }], [])).toThrow(/missing/)
})
