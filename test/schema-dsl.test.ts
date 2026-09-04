import { expect, test } from 'vitest'
import {
  col, compileOps, defineSchema, diffSchema, Migrator, table, type Migration, type SqlSession,
} from '../src/index'

const empty = defineSchema({})
const users = defineSchema({
  users: table({ id: col.integer().primaryKey(), email: col.text().unique(), active: col.boolean().defaultSql('1') }).index('users_email_idx', ['email']),
})
const orders = defineSchema({
  users: table({ id: col.integer().primaryKey(), email: col.text().unique() }),
  orders: table({
    id: col.integer().primaryKey(),
    userId: col.integer().references('users', 'id', { onDelete: 'cascade' }),
    note: col.text().nullable(),
    paidAt: col.timestamptz().nullable(),
  }).index('orders_user_idx', ['userId']),
})

function migration(id: string, from: typeof empty, to: typeof empty): Migration {
  return { id, up: diffSchema(from, to), down: diffSchema(to, from) }
}

type SqliteDb = { exec: (sql: string) => void; prepare: (sql: string) => { all: (...p: unknown[]) => unknown; run: (...p: unknown[]) => unknown }; close: () => void }

function sqlite(): { session: SqlSession; names: () => string[]; close: () => void } {
  const loaded = (globalThis as { process?: { getBuiltinModule?: (id: string) => { DatabaseSync: new (path: string) => SqliteDb } } }).process?.getBuiltinModule?.('node:sqlite')
  if (!loaded) throw new Error('node:sqlite is not available in this runtime')
  const db = new loaded.DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const session: SqlSession = {
    exec: (sql, params) => (!params || params.length === 0 ? db.exec(sql) : db.prepare(sql).run(...params)),
    all: (sql, params) => db.prepare(sql).all(...(params ?? [])) as Record<string, unknown>[],
  }
  const names = () => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((row) => row.name)
  return { session, names, close: () => db.close() }
}

test('compiles dialect types, FKs, defaults; create order follows FK edges', () => {
  const up = diffSchema(empty, orders)
  expect(up.map((op) => op.kind)).toEqual(['createTable', 'createTable', 'createIndex'])
  expect(up[0] && up[0].kind === 'createTable' ? up[0].table.name : '').toBe('users')
  expect(up[1] && up[1].kind === 'createTable' ? up[1].table.name : '').toBe('orders')
  const pg = compileOps(up, 'postgres')
  expect(pg[0]).toContain('"email" TEXT NOT NULL UNIQUE')
  expect(pg[1]).toContain('"paidAt" TIMESTAMPTZ')
  expect(pg[1]).toContain('FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE')
  expect(compileOps(up, 'sqlite')[1]).toContain('"paidAt" TEXT')
  expect(compileOps(up, 'sqlite')[1]).toContain('"userId" INTEGER NOT NULL')
  expect(compileOps(diffSchema(empty, users), 'sqlite')[0]).toContain('DEFAULT 1')
  expect(compileOps([{ kind: 'addColumn', table: 'users', column: { name: 'bio', kind: 'text', nullable: true, primaryKey: false, unique: false } }], 'postgres')[0]).toBe(
    'ALTER TABLE "users" ADD COLUMN "bio" TEXT',
  )
  expect(diffSchema(orders, empty).map((op) => (op.kind === 'dropTable' ? op.name : op.kind))).toEqual(['dropIndex', 'orders', 'users'])
})

test('schema DSL rejects cycles, bad defaults, and in-place column rewrites', () => {
  expect(() => table({})).toThrow(/at least one column/)
  expect(() => defineSchema({ t: table({ a: col.integer().primaryKey(), b: col.integer().primaryKey() }) })).toThrow(/primary keys/)
  expect(() => defineSchema({ t: table({ a: col.integer().references('t', 'a', { onDelete: 'set null' }) }) })).toThrow(/nullable/)
  expect(() => defineSchema({ t: table({ a: col.integer().references('missing', 'id') }) })).toThrow(/unknown table/)
  expect(() =>
    defineSchema({
      a: table({ id: col.integer().primaryKey(), bId: col.integer().references('b', 'id') }),
      b: table({ id: col.integer().primaryKey(), aId: col.integer().references('a', 'id') }),
    }),
  ).toThrow(/cycle/)
  expect(() => col.text().defaultSql('x; drop')).toThrow(/Unsafe DEFAULT/)
  expect(() => table({ id: col.integer() }).index('empty', [])).toThrow(/at least one column/)
  expect(() => defineSchema({ t: table({ id: col.integer() }).index('t_x', ['nope']) })).toThrow(/unknown column/)
  const orgs = defineSchema({ orgs: table({ id: col.integer().primaryKey(), parentId: col.integer().nullable().references('orgs', 'id') }) })
  expect(compileOps(diffSchema(empty, orgs), 'sqlite')[0]).toContain('FOREIGN KEY ("parentId") REFERENCES "orgs" ("id")')
  expect(() => diffSchema(users, defineSchema({ users: table({ id: col.integer().primaryKey(), email: col.integer().unique() }) }))).toThrow(/in place/)
  const added = defineSchema({
    users: table({ id: col.integer().primaryKey(), email: col.text().unique(), active: col.boolean().defaultSql('1'), bio: col.text().nullable() }).index(
      'users_email_idx',
      ['email'],
    ),
  })
  expect(diffSchema(users, added).map((op) => op.kind)).toEqual(['addColumn'])
  expect(diffSchema(added, users).map((op) => op.kind)).toEqual(['dropColumn'])
  const pkCol = { name: 'id', kind: 'integer' as const, nullable: false, primaryKey: true, unique: false }
  const uniqCol = { name: 'e', kind: 'text' as const, nullable: false, primaryKey: false, unique: true }
  expect(() => compileOps([{ kind: 'addColumn', table: 't', column: pkCol }], 'sqlite')).toThrow(/PRIMARY KEY/)
  expect(() => compileOps([{ kind: 'addColumn', table: 't', column: uniqCol }], 'sqlite')).toThrow(/UNIQUE/)
})

test('sqlite drops indexes before columns and rejects unsafe ALTER TABLE', () => {
  const indexed = defineSchema({
    items: table({ id: col.integer().primaryKey(), label: col.text() }).index('items_label_idx', ['label']),
  })
  const stripped = defineSchema({
    items: table({ id: col.integer().primaryKey() }),
  })
  const dropIndexed = diffSchema(indexed, stripped)
  expect(dropIndexed.map((op) => op.kind)).toEqual(['dropIndex', 'dropColumn'])
  expect(dropIndexed.filter((op) => op.kind === 'dropIndex')).toHaveLength(1)
  expect(dropIndexed[1] && dropIndexed[1].kind === 'dropColumn' ? dropIndexed[1].column.name : '').toBe('label')

  const uniqueCol = defineSchema({ t: table({ id: col.integer().primaryKey(), email: col.text().unique() }) })
  const noUnique = defineSchema({ t: table({ id: col.integer().primaryKey() }) })
  expect(() => compileOps(diffSchema(uniqueCol, noUnique), 'sqlite')).toThrow(/UNIQUE/)

  const pkTable = defineSchema({ t: table({ id: col.integer().primaryKey(), name: col.text() }) })
  const noPk = defineSchema({ t: table({ name: col.text() }) })
  expect(() => compileOps(diffSchema(pkTable, noPk), 'sqlite')).toThrow(/PRIMARY KEY/)

  const withFk = defineSchema({
    users: table({ id: col.integer().primaryKey() }),
    orders: table({ id: col.integer().primaryKey(), userId: col.integer().references('users', 'id') }),
  })
  const noFk = defineSchema({
    users: table({ id: col.integer().primaryKey() }),
    orders: table({ id: col.integer().primaryKey() }),
  })
  expect(() => compileOps(diffSchema(withFk, noFk), 'sqlite')).toThrow(/foreign key/)

  const notNullAdd = {
    kind: 'addColumn' as const,
    table: 't',
    column: { name: 'n', kind: 'text' as const, nullable: false, primaryKey: false, unique: false },
  }
  expect(() => compileOps([notNullAdd], 'sqlite')).toThrow(/NOT NULL/)
  expect(compileOps([notNullAdd], 'postgres')[0]).toContain('NOT NULL')

  const withNote = defineSchema({
    items: table({ id: col.integer().primaryKey(), note: col.text().nullable() }),
  })
  const { session, close } = sqlite()
  try {
    const m = new Migrator(session, 'sqlite')
    const dropLabel = [migration('001_items', empty, indexed), migration('002_drop_label', indexed, stripped)]
    expect(m.migrateUp([dropLabel[0]!])).toEqual(['001_items'])
    session.exec(`INSERT INTO "items" ("id", "label") VALUES (1, 'a')`)
    expect(m.migrateUp(dropLabel)).toEqual(['002_drop_label'])
    expect(session.all(`SELECT "id" FROM "items"`)).toEqual([{ id: 1 }])
    expect(() =>
      m.migrateUp([...dropLabel, { id: '003_unique', up: diffSchema(uniqueCol, noUnique), down: [] }]),
    ).toThrow(/UNIQUE/)
    expect(() => m.migrateUp([...dropLabel, { id: '003_pk', up: diffSchema(pkTable, noPk), down: [] }])).toThrow(/PRIMARY KEY/)
    expect(() => m.migrateUp([...dropLabel, { id: '003_fk', up: diffSchema(withFk, noFk), down: [] }])).toThrow(/foreign key/)
    expect(() => m.migrateUp([...dropLabel, { id: '003_nn', up: [notNullAdd], down: [] }])).toThrow(/NOT NULL/)
    const noteChain = [...dropLabel, migration('003_note', stripped, withNote)]
    expect(m.migrateUp(noteChain)).toEqual(['003_note'])
    expect(session.all(`SELECT "note" FROM "items"`)).toEqual([{ note: null }])
    expect(m.migrateDown(noteChain, 1)).toEqual(['003_note'])
    expect(session.all(`SELECT "id" FROM "items"`)).toEqual([{ id: 1 }])
  } finally {
    close()
  }
})

test('migrator applies, skips, rolls back, and walks down against sqlite', () => {
  const { session, names, close } = sqlite()
  try {
    const m = new Migrator(session, 'sqlite')
    const chain = [migration('001_users', empty, users), migration('002_orders', users, orders)]
    expect(m.migrateUp(chain)).toEqual(['001_users', '002_orders'])
    expect(m.migrateUp(chain)).toEqual([])
    expect(m.applied()).toEqual(['001_users', '002_orders'])
    expect(names()).toEqual(['_schema_migrations', 'orders', 'users'])
    expect(m.migrateDown(chain, 1)).toEqual(['002_orders'])
    expect(names()).toEqual(['_schema_migrations', 'users'])
    expect(m.migrateDown(chain, 8)).toEqual(['001_users'])
    expect(names()).toEqual(['_schema_migrations'])
    expect(m.migrateDown(chain, 0)).toEqual([])
    m.migrateUp(chain)
    const boom: Migration = { id: '003_dup', up: diffSchema(empty, users), down: [] }
    expect(() => m.migrateUp([...chain, boom])).toThrow()
    expect(m.applied()).toEqual(['001_users', '002_orders'])
    session.exec(`INSERT INTO "_schema_migrations" ("id", "appliedAt") VALUES (?, ?)`, ['004_ghost', '2026-01-01T00:00:00.000Z'])
    expect(() =>
      m.migrateUp([...chain, { id: '003_mid', up: [], down: [] }, { id: '004_ghost', up: [], down: [] }]),
    ).toThrow(/prefix/)
    expect(() => m.migrateUp([{ id: '1_bad', up: [], down: [] }])).toThrow(/Invalid migration id/)
    expect(() => m.migrateDown(chain, -1)).toThrow(/non-negative/)
  } finally {
    close()
  }
  const stmts: string[] = []
  const pg: SqlSession = { exec: (sql) => { stmts.push(sql) }, all: () => [] }
  expect(new Migrator(pg, 'postgres').migrateUp([{ id: '001_init', up: [], down: [] }])).toEqual(['001_init'])
  expect(stmts.some((sql) => sql.includes('VALUES ($1, $2)'))).toBe(true)
  expect(stmts.every((sql) => !sql.includes('?'))).toBe(true)
})
