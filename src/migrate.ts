import { compileOps, topoTables, type DatabaseSchema, type FieldDef, type IndexDef, type MigrationOp, type TableSchema } from './ddl'
import type { Dialect } from './query'
import { quoteIdent } from './schema'

export type SqlSession = {
  exec: (sql: string, params?: readonly unknown[]) => void
  all: (sql: string, params?: readonly unknown[]) => Record<string, unknown>[]
}

export type Migration = { readonly id: string; readonly up: readonly MigrationOp[]; readonly down: readonly MigrationOp[] }

const JOURNAL = '_schema_migrations'
const ID_RE = /^\d{3}_[A-Za-z0-9_]+$/

function tableMap(schema: DatabaseSchema): Map<string, TableSchema> {
  return new Map(schema.tables.map((t) => [t.name, t]))
}
function fieldEq(a: FieldDef, b: FieldDef): boolean {
  return JSON.stringify([a.kind, a.nullable, a.primaryKey, a.unique, a.defaultSql, a.references]) === JSON.stringify([b.kind, b.nullable, b.primaryKey, b.unique, b.defaultSql, b.references])
}
function indexEq(a: IndexDef, b: IndexDef): boolean {
  return a.unique === b.unique && a.columns.length === b.columns.length && a.columns.every((c, i) => c === b.columns[i])
}
export function diffSchema(from: DatabaseSchema, to: DatabaseSchema): MigrationOp[] {
  const ops: MigrationOp[] = []
  const prev = tableMap(from)
  const created = to.tables.filter((t) => !prev.has(t.name))
  const dropped = from.tables.filter((t) => !to.tables.some((x) => x.name === t.name))
  const droppedIndexes = new Set<string>()
  for (const table of topoTables(created)) {
    ops.push({ kind: 'createTable', table: { name: table.name, columns: table.columns, indexes: [] } })
  }
  for (const table of to.tables) {
    const before = prev.get(table.name)
    if (!before) continue
    const beforeCols = new Map(before.columns.map((c) => [c.name, c]))
    const afterCols = new Map(table.columns.map((c) => [c.name, c]))
    for (const col of table.columns) {
      const old = beforeCols.get(col.name)
      if (!old) ops.push({ kind: 'addColumn', table: table.name, column: col })
      else if (!fieldEq(old, col)) throw new Error(`Cannot alter column ${table.name}.${col.name} in place; drop and add it`)
    }
    const removed = before.columns.filter((c) => !afterCols.has(c.name))
    const removedNames = new Set(removed.map((c) => c.name))
    for (const idx of before.indexes) {
      if (!idx.columns.some((name) => removedNames.has(name)) || droppedIndexes.has(idx.name)) continue
      ops.push({ kind: 'dropIndex', name: idx.name })
      droppedIndexes.add(idx.name)
    }
    for (const col of removed) {
      ops.push({ kind: 'dropColumn', table: table.name, column: col })
    }
  }
  for (const table of to.tables) {
    const before = prev.get(table.name)
    if (!before) {
      for (const idx of table.indexes) ops.push({ kind: 'createIndex', table: table.name, index: idx })
      continue
    }
    const oldIdx = new Map(before.indexes.map((i) => [i.name, i]))
    const newIdx = new Map(table.indexes.map((i) => [i.name, i]))
    for (const idx of table.indexes) {
      const old = oldIdx.get(idx.name)
      if (!old) ops.push({ kind: 'createIndex', table: table.name, index: idx })
      else if (!indexEq(old, idx)) {
        if (!droppedIndexes.has(idx.name)) {
          ops.push({ kind: 'dropIndex', name: idx.name })
          droppedIndexes.add(idx.name)
        }
        ops.push({ kind: 'createIndex', table: table.name, index: idx })
      }
    }
    for (const idx of before.indexes) {
      if (newIdx.has(idx.name) || droppedIndexes.has(idx.name)) continue
      ops.push({ kind: 'dropIndex', name: idx.name })
      droppedIndexes.add(idx.name)
    }
  }
  for (const table of [...topoTables(dropped)].reverse()) {
    for (const idx of table.indexes) {
      if (droppedIndexes.has(idx.name)) continue
      ops.push({ kind: 'dropIndex', name: idx.name })
      droppedIndexes.add(idx.name)
    }
    ops.push({ kind: 'dropTable', name: table.name })
  }
  return ops
}
function assertIds(migrations: readonly Migration[]): void {
  const seen = new Set<string>()
  let prev: string | undefined
  for (const m of migrations) {
    if (!ID_RE.test(m.id)) throw new Error(`Invalid migration id ${JSON.stringify(m.id)}`)
    if (seen.has(m.id)) throw new Error(`Duplicate migration id ${m.id}`)
    seen.add(m.id)
    if (prev !== undefined && m.id <= prev) throw new Error(`Migrations must be sorted by id (${prev} then ${m.id})`)
    prev = m.id
  }
}
export class Migrator {
  constructor(private readonly db: SqlSession, private readonly dialect: Dialect) {}

  applied(): string[] {
    this.ensureJournal()
    return this.db.all(`SELECT ${quoteIdent('id')} FROM ${quoteIdent(JOURNAL)} ORDER BY ${quoteIdent('id')}`).map((row) => {
      if (typeof row.id !== 'string') throw new Error('Corrupt migration journal')
      return row.id
    })
  }
  migrateUp(migrations: readonly Migration[]): string[] {
    assertIds(migrations)
    const done = this.applied()
    this.assertPrefix(migrations, done)
    const ran: string[] = []
    for (const m of migrations) {
      if (done.includes(m.id)) continue
      this.apply(m, 'up')
      ran.push(m.id)
    }
    return ran
  }
  migrateDown(migrations: readonly Migration[], steps = 1): string[] {
    if (!Number.isInteger(steps) || steps < 0) throw new Error(`migrateDown() expects a non-negative integer, got ${String(steps)}`)
    assertIds(migrations)
    const done = this.applied()
    this.assertPrefix(migrations, done)
    const byId = new Map(migrations.map((m) => [m.id, m]))
    const ran: string[] = []
    for (let i = 0; i < steps; i += 1) {
      const id = done[done.length - 1 - i]
      if (id === undefined) break
      const m = byId.get(id)
      if (!m) throw new Error(`Applied migration ${id} is not in the provided set`)
      this.apply(m, 'down')
      ran.push(id)
    }
    return ran
  }
  private ensureJournal(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(JOURNAL)} (${quoteIdent('id')} TEXT NOT NULL PRIMARY KEY, ${quoteIdent('appliedAt')} TEXT NOT NULL)`,
    )
  }
  private assertPrefix(migrations: readonly Migration[], applied: string[]): void {
    const ids = migrations.map((m) => m.id)
    const known = new Set(ids)
    for (const id of applied) {
      if (!known.has(id)) throw new Error(`Unknown applied migration ${JSON.stringify(id)}`)
    }
    for (let i = 0; i < applied.length; i += 1) {
      if (applied[i] !== ids[i]) throw new Error('Migration history is not a prefix of the migration list')
    }
  }
  private ph(n: number): string {
    return this.dialect === 'sqlite' ? '?' : `$${n}`
  }
  private apply(m: Migration, direction: 'up' | 'down'): void {
    this.db.exec('BEGIN')
    try {
      for (const sql of compileOps(direction === 'up' ? m.up : m.down, this.dialect)) this.db.exec(sql)
      if (direction === 'up') {
        this.db.exec(`INSERT INTO ${quoteIdent(JOURNAL)} (${quoteIdent('id')}, ${quoteIdent('appliedAt')}) VALUES (${this.ph(1)}, ${this.ph(2)})`, [
          m.id,
          new Date().toISOString(),
        ])
      } else {
        this.db.exec(`DELETE FROM ${quoteIdent(JOURNAL)} WHERE ${quoteIdent('id')} = ${this.ph(1)}`, [m.id])
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}
