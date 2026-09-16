import { expect, test } from 'vitest'
import { boolean, defineTable, integer, text, TransactionManager, UnitOfWork, type SqlSession } from '../src/index'

const accounts = defineTable('accounts', { id: integer(), name: text(), balanceCents: integer(), active: boolean() })

type SqliteDb = {
  exec: (sql: string) => void
  prepare: (sql: string) => { all: (...p: unknown[]) => unknown; run: (...p: unknown[]) => unknown }
  close: () => void
}

function sqlite(): { session: SqlSession; queries: () => number; rows: () => Record<string, unknown>[]; close: () => void } {
  const loaded = (
    globalThis as { process?: { getBuiltinModule?: (id: string) => { DatabaseSync: new (path: string) => SqliteDb } } }
  ).process?.getBuiltinModule?.('node:sqlite')
  if (!loaded) throw new Error('node:sqlite is not available in this runtime')
  const db = new loaded.DatabaseSync(':memory:')
  db.exec(`CREATE TABLE "accounts" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "balanceCents" INTEGER NOT NULL, "active" INTEGER NOT NULL)`)
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
  return {
    session,
    queries: () => queries,
    rows: () => db.prepare('SELECT * FROM "accounts" ORDER BY "id"').all() as Record<string, unknown>[],
    close: () => db.close(),
  }
}

test('identity map returns the same object for repeated attach() of one row', () => {
  const db = sqlite()
  const uow = new UnitOfWork(db.session, 'sqlite')
  const row = { id: 1, name: 'pat', balanceCents: 500, active: true }
  const first = uow.attach(accounts, 'id', row)
  const second = uow.attach(accounts, 'id', { id: 1, name: 'stale-copy', balanceCents: 0, active: false })
  expect(second).toBe(first)
  expect(second.name).toBe('pat')
  db.close()
})

test('attach and registerNew reject rows missing their primary key', () => {
  const db = sqlite()
  const uow = new UnitOfWork(db.session, 'sqlite')
  expect(() => uow.attach(accounts, 'id', { name: 'x' } as never)).toThrow(/missing primary key/)
  expect(() => uow.registerNew(accounts, 'id', { id: null, name: 'x' } as never)).toThrow(/missing primary key/)
  expect(() => uow.attach(accounts, 'ssn', { id: 1 } as never)).toThrow(/no column/)
  db.close()
})

test('registerNew rejects a pk already tracked; remove rejects an untracked pk', () => {
  const db = sqlite()
  const uow = new UnitOfWork(db.session, 'sqlite')
  uow.registerNew(accounts, 'id', { id: 1, name: 'a', balanceCents: 0, active: true })
  expect(() => uow.registerNew(accounts, 'id', { id: 1, name: 'b', balanceCents: 0, active: true })).toThrow(/already tracked/)
  expect(() => uow.remove(accounts, 'id', 99)).toThrow(/untracked/)
  db.close()
})

test('flush() with nothing pending never touches the session', () => {
  const db = sqlite()
  const uow = new UnitOfWork(db.session, 'sqlite')
  uow.attach(accounts, 'id', { id: 1, name: 'a', balanceCents: 0, active: true })
  const before = db.queries()
  expect(uow.flush()).toBe(0)
  expect(db.queries()).toBe(before)
  db.close()
})

test('flush() inserts new entities inside a transaction', () => {
  const db = sqlite()
  const uow = new UnitOfWork(db.session, 'sqlite')
  uow.registerNew(accounts, 'id', { id: 1, name: 'pat', balanceCents: 500, active: true })
  uow.registerNew(accounts, 'id', { id: 2, name: 'lee', balanceCents: 0, active: false })
  expect(uow.flush()).toBe(2)
  expect(db.rows()).toEqual([
    { id: 1, name: 'pat', balanceCents: 500, active: 1 },
    { id: 2, name: 'lee', balanceCents: 0, active: 0 },
  ])
})

test('flush() only updates columns that actually changed', () => {
  const db = sqlite()
  const uow = new UnitOfWork(db.session, 'sqlite')
  const row = uow.registerNew(accounts, 'id', { id: 1, name: 'pat', balanceCents: 500, active: true })
  uow.flush()
  row.balanceCents = 400
  const updateCount = uow.flush()
  expect(updateCount).toBe(1)
  expect(db.rows()).toEqual([{ id: 1, name: 'pat', balanceCents: 400, active: 1 }])
  expect(uow.flush()).toBe(0)
})

test('remove() deletes on flush and forgets the entity so a fresh attach starts clean', () => {
  const db = sqlite()
  const uow = new UnitOfWork(db.session, 'sqlite')
  uow.registerNew(accounts, 'id', { id: 1, name: 'pat', balanceCents: 500, active: true })
  uow.flush()
  uow.remove(accounts, 'id', 1)
  expect(uow.flush()).toBe(1)
  expect(db.rows()).toEqual([])
  expect(uow.isTracked(accounts, 1)).toBe(false)
  const revived = uow.attach(accounts, 'id', { id: 1, name: 'new-pat', balanceCents: 0, active: false })
  expect(revived.name).toBe('new-pat')
})

test('remove() on a never-flushed new entity just drops it, no DELETE is issued', () => {
  const db = sqlite()
  const uow = new UnitOfWork(db.session, 'sqlite')
  uow.registerNew(accounts, 'id', { id: 1, name: 'pat', balanceCents: 500, active: true })
  uow.remove(accounts, 'id', 1)
  expect(uow.isTracked(accounts, 1)).toBe(false)
  const before = db.queries()
  expect(uow.flush()).toBe(0)
  expect(db.queries()).toBe(before)
  db.close()
})

test('a failing flush rolls back every write and leaves entities pending for retry', () => {
  const db = sqlite()
  const uow = new UnitOfWork(db.session, 'sqlite')
  uow.registerNew(accounts, 'id', { id: 1, name: 'ok', balanceCents: 0, active: true })
  db.session.exec(`INSERT INTO "accounts" ("id", "name", "balanceCents", "active") VALUES (2, 'seed', 0, 0)`)
  uow.registerNew(accounts, 'id', { id: 2, name: 'collides-with-existing-row', balanceCents: 0, active: true })
  expect(() => uow.flush()).toThrow()
  expect(db.rows().map((r) => r.id)).toEqual([2])
  expect(db.rows()[0]?.name).toBe('seed')
  uow.remove(accounts, 'id', 2)
  expect(uow.flush()).toBe(1)
  expect(db.rows().map((r) => r.name).sort()).toEqual(['ok', 'seed'])
  db.close()
})

test('TransactionManager rejects commit/rollback with no open transaction', () => {
  const db = sqlite()
  const tx = new TransactionManager(db.session)
  expect(() => tx.commit()).toThrow(/no open transaction/)
  expect(() => tx.rollback()).toThrow(/no open transaction/)
  db.close()
})

test('nested run() uses a savepoint so an inner failure does not undo the outer transaction', () => {
  const db = sqlite()
  const tx = new TransactionManager(db.session)
  tx.run(() => {
    db.session.exec(`INSERT INTO "accounts" ("id", "name", "balanceCents", "active") VALUES (1, 'a', 0, 1)`)
    expect(() =>
      tx.run(() => {
        db.session.exec(`INSERT INTO "accounts" ("id", "name", "balanceCents", "active") VALUES (2, 'b', 0, 1)`)
        throw new Error('inner boom')
      }),
    ).toThrow('inner boom')
    db.session.exec(`INSERT INTO "accounts" ("id", "name", "balanceCents", "active") VALUES (3, 'c', 0, 1)`)
  })
  expect(db.rows().map((r) => r.id)).toEqual([1, 3])
  expect(tx.isOpen).toBe(false)
})

test('UnitOfWork.flush() nested inside a manual transaction is undone by an outer rollback', () => {
  const db = sqlite()
  const tx = new TransactionManager(db.session)
  const uow = new UnitOfWork(db.session, 'sqlite', tx)
  tx.begin()
  uow.registerNew(accounts, 'id', { id: 1, name: 'pat', balanceCents: 500, active: true })
  expect(uow.flush()).toBe(1)
  expect(db.rows()).toHaveLength(1)
  tx.rollback()
  expect(db.rows()).toEqual([])
  expect(tx.isOpen).toBe(false)
})
