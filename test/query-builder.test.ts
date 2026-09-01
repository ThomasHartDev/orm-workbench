import { expect, expectTypeOf, test } from 'vitest'
import {
  alias, and, boolean, defineTable, eq, from, gt, inList, integer, isNotNull,
  isNull, like, ne, not, numeric, or, quoteIdent, text, timestamptz, type InferRow,
} from '../src/index'

const users = defineTable('users', {
  id: integer(),
  email: text(),
  active: boolean(),
})

const orders = defineTable('orders', {
  id: integer(),
  userId: integer(),
  totalCents: integer(),
  status: text(),
  note: text(),
  paidAt: timestamptz(),
  amount: numeric(),
})

type SqliteDb = {
  exec: (sql: string) => void
  prepare: (sql: string) => { all: (...params: unknown[]) => unknown }
  close: () => void
}

function execSqlite(sql: string, params: unknown[], schema: string): void {
  const loaded = (
    globalThis as {
      process?: { getBuiltinModule?: (id: string) => { DatabaseSync: new (path: string) => SqliteDb } }
    }
  ).process?.getBuiltinModule?.('node:sqlite')
  if (!loaded) {
    throw new Error('node:sqlite is not available in this runtime')
  }
  const db = new loaded.DatabaseSync(':memory:')
  try {
    db.exec(schema)
    db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

test('CI and package engines pin Node 22 so node:sqlite is a hard require', () => {
  const proc = (
    globalThis as {
      process?: {
        versions?: { node?: string }
        getBuiltinModule?: (id: string) => {
          readFileSync: (path: string, encoding: string) => string
        }
      }
    }
  ).process
  const major = Number((proc?.versions?.node ?? '0').split('.')[0])
  expect(major).toBeGreaterThanOrEqual(22)
  const fs = proc?.getBuiltinModule?.('node:fs')
  if (!fs) {
    throw new Error('node:fs is not available in this runtime')
  }
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
    engines?: { node?: string }
  }
  expect(pkg.engines?.node).toBe('>=22')
  const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8')
  expect(ci).toMatch(/node-version:\s*22\b/)
  expect(ci).not.toMatch(/node-version:\s*20\b/)
})

test('binds values and never interpolates them into SQL', () => {
  const poison = "open'; DROP TABLE orders;--"
  const compiled = from(orders)
    .where(eq(orders.status, poison))
    .select({ id: orders.id, status: orders.status })
    .compile()

  expect(compiled.sql).toBe(
    'SELECT "orders"."id" AS "id", "orders"."status" AS "status"\nFROM "orders" AS "orders"\nWHERE "orders"."status" = $1',
  )
  expect(compiled.params).toEqual([poison])
  expect(compiled.sql).not.toContain('DROP TABLE')
})

test('inner join, filters, sort, and bound limit compile as Postgres $n', () => {
  const compiled = from(orders)
    .innerJoin(users, eq(orders.userId, users.id))
    .where(and(eq(users.active, true), gt(orders.totalCents, 500)))
    .select({ orderId: orders.id, email: users.email, totalCents: orders.totalCents })
    .orderBy(orders.id, 'desc')
    .limit(20)
    .compile('postgres')

  expect(compiled.sql.split('\n')).toEqual([
    'SELECT "orders"."id" AS "orderId", "users"."email" AS "email", "orders"."totalCents" AS "totalCents"',
    'FROM "orders" AS "orders"',
    'INNER JOIN "users" AS "users" ON "orders"."userId" = "users"."id"',
    'WHERE ("users"."active" = $1 AND "orders"."totalCents" > $2)',
    'ORDER BY "orders"."id" DESC',
    'LIMIT $3',
  ])
  expect(compiled.params).toEqual([true, 500, 20])
})

test('sqlite uses ? placeholders and LIMIT -1 before a lone OFFSET', () => {
  const sqlite = from(users)
    .where(eq(users.email, 'a@b.c'))
    .select({ email: users.email })
    .offset(3)
    .compile('sqlite')
  expect(sqlite.sql.split('\n')).toEqual([
    'SELECT "users"."email" AS "email"',
    'FROM "users" AS "users"',
    'WHERE "users"."email" = ?',
    'LIMIT -1',
    'OFFSET ?',
  ])
  expect(sqlite.sql).not.toMatch(/\$\d/)
  expect(sqlite.params).toEqual(['a@b.c', 3])

  const withLimit = from(users)
    .select({ email: users.email })
    .limit(10)
    .offset(3)
    .compile('sqlite')
  expect(withLimit.sql).toContain('LIMIT ?')
  expect(withLimit.sql).toContain('OFFSET ?')
  expect(withLimit.sql).not.toContain('LIMIT -1')
  expect(withLimit.params).toEqual([10, 3])

  const usersSchema = 'CREATE TABLE "users" ("id" INTEGER, "email" TEXT, "active" INTEGER)'
  execSqlite(sqlite.sql, sqlite.params, usersSchema)
  execSqlite(withLimit.sql, withLimit.params, usersSchema)
  const bareOffset = sqlite.sql.replace('\nLIMIT -1', '')
  expect(() => execSqlite(bareOffset, sqlite.params, usersSchema)).toThrow(/syntax error/i)
})

test('postgres allows OFFSET without LIMIT; nested boolean, left join, null, like, NOT', () => {
  const offsetOnly = from(users)
    .select({ email: users.email })
    .offset(3)
    .compile('postgres')
  expect(offsetOnly.sql).toContain('OFFSET $1')
  expect(offsetOnly.sql).not.toContain('LIMIT')
  expect(offsetOnly.params).toEqual([3])

  const nested = from(orders)
    .leftJoin(users, eq(orders.userId, users.id))
    .where(or(and(isNull(orders.paidAt), like(orders.note, '%rush%')), not(eq(orders.status, 'void'))))
    .select({ id: orders.id, email: users.email })
    .compile()
  expect(nested.sql).toContain('LEFT JOIN "users" AS "users"')
  expect(nested.sql).toContain('"orders"."paidAt" IS NULL')
  expect(nested.sql).toContain('"orders"."note" LIKE $1')
  expect(nested.sql).toContain('(NOT ("orders"."status" = $2))')
  expect(nested.params).toEqual(['%rush%', 'void'])
})

test('self-join aliases keep both sides distinct', () => {
  const child = alias(users, 'child')
  const parent = alias(users, 'parent')
  const compiled = from(child)
    .innerJoin(parent, eq(child.id, parent.id))
    .select({ childEmail: child.email, parentEmail: parent.email })
    .compile()
  expect(compiled.sql).toContain('FROM "users" AS "child"')
  expect(compiled.sql).toContain('INNER JOIN "users" AS "parent" ON "child"."id" = "parent"."id"')
})

test('empty IN/OR are false, empty AND is true, IN binds duplicates', () => {
  const empty = from(orders)
    .where(and(inList(orders.id, []), or(), and()))
    .select({ id: orders.id })
    .compile()
  expect(empty.sql).toContain('WHERE (1 = 0 AND 1 = 0 AND 1 = 1)')
  expect(empty.params).toEqual([])

  const listed = from(orders)
    .where(inList(orders.status, ['open', 'open', 'paid']))
    .select({ id: orders.id })
    .compile()
  expect(listed.sql).toContain('IN ($1, $2, $3)')
  expect(listed.params).toEqual(['open', 'open', 'paid'])
})

test('NULL equality is rejected; IS NULL does not allocate a bind', () => {
  expect(() => eq(orders.note, null as unknown as string)).toThrow(/isNull/)
  expect(() => ne(orders.note, undefined as unknown as string)).toThrow(/isNull/)
  expect(() => inList(orders.id, [1, null as unknown as number])).toThrow(/inList/)
  const compiled = from(orders).where(isNotNull(orders.paidAt)).select({ id: orders.id }).compile()
  expect(compiled.sql).toContain('"orders"."paidAt" IS NOT NULL')
  expect(compiled.params).toEqual([])
})

test('rejects poisoned identifiers, empty select, duplicate aliases, and bad limits', () => {
  expect(() => quoteIdent('orders;drop')).toThrow(/Invalid SQL identifier/)
  expect(() => defineTable('users-x', { id: integer() })).toThrow(/Invalid SQL identifier/)
  expect(() => from(orders).select({})).toThrow(/at least one column/)
  expect(() => from(users).innerJoin(users, eq(users.id, users.id))).toThrow(/already in the query/)
  expect(() => from(orders).select({ id: orders.id }).select({ id: orders.id })).toThrow(/already called/)
  expect(() => from(orders).limit(-1)).toThrow(/non-negative/)
  expect(() => from(orders).offset(1.5)).toThrow(/non-negative/)
  expect(() => from(orders).compile()).toThrow(/select/)
})

test('builder is immutable; stacked where/orderBy; limit 0 binds', () => {
  const base = from(orders).select({ id: orders.id })
  const open = base.where(eq(orders.status, 'open'))
  const both = open.where(eq(orders.amount, '10.00'))
  expect(base.compile().sql).not.toContain('WHERE')
  expect(open.compile().params).toEqual(['open'])
  expect(both.compile().sql).toContain('WHERE ("orders"."status" = $1 AND "orders"."amount" = $2)')
  expect(both.compile().params).toEqual(['open', '10.00'])

  const ordered = from(orders)
    .select({ id: orders.id })
    .orderBy(orders.status)
    .orderBy(orders.id, 'desc')
    .limit(0)
    .compile()
  expect(ordered.sql).toContain('ORDER BY "orders"."status" ASC, "orders"."id" DESC')
  expect(ordered.params).toEqual([0])
})

test('select shape infers row field types from column refs', () => {
  const query = from(orders).select({ orderId: orders.id, status: orders.status })
  type Row = InferRow<{ orderId: typeof orders.id; status: typeof orders.status }>
  expectTypeOf<Row>().toEqualTypeOf<{ orderId: number; status: string }>()
  expectTypeOf(query.compile().sql).toEqualTypeOf<string>()
  eq(orders.id, 1)
  // @ts-expect-error integer columns reject string literals
  eq(orders.id, '1')
})
