import type { SqlSession } from './migrate'
import type { Dialect } from './query'
import { quoteIdent, type AnyTable } from './schema'

export class TransactionManager {
  private depth = 0

  constructor(private readonly session: SqlSession) {}

  get isOpen(): boolean {
    return this.depth > 0
  }

  begin(): void {
    if (this.depth === 0) this.session.exec('BEGIN')
    else this.session.exec(`SAVEPOINT ${this.savepointName(this.depth)}`)
    this.depth += 1
  }

  commit(): void {
    if (this.depth === 0) throw new Error('commit() called with no open transaction')
    this.depth -= 1
    if (this.depth === 0) this.session.exec('COMMIT')
    else this.session.exec(`RELEASE SAVEPOINT ${this.savepointName(this.depth)}`)
  }

  rollback(): void {
    if (this.depth === 0) throw new Error('rollback() called with no open transaction')
    this.depth -= 1
    if (this.depth === 0) {
      this.session.exec('ROLLBACK')
      return
    }
    const name = this.savepointName(this.depth)
    this.session.exec(`ROLLBACK TO SAVEPOINT ${name}`)
    this.session.exec(`RELEASE SAVEPOINT ${name}`)
  }

  run<T>(fn: () => T): T {
    this.begin()
    try {
      const result = fn()
      this.commit()
      return result
    } catch (err) {
      this.rollback()
      throw err
    }
  }

  private savepointName(depth: number): string {
    return `sp_${depth}`
  }
}

type EntityState = 'clean' | 'new' | 'removed'

type Tracked<Row extends Record<string, unknown>> = {
  readonly table: AnyTable
  readonly pkColumn: string
  readonly row: Row
  snapshot: Row
  state: EntityState
}

function entityKey(table: AnyTable, pkValue: unknown): string {
  return `${table.$name}:${String(pkValue)}`
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return Object.is(a, b)
}

function encodeValue(value: unknown, dialect: Dialect): unknown {
  if (dialect !== 'sqlite') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  return value
}

function requirePkColumn(table: AnyTable, pkColumn: string): void {
  if (!(pkColumn in table.$columns)) {
    throw new Error(`${table.$name} has no column ${JSON.stringify(pkColumn)}`)
  }
}

function requireRowHasPk<Row extends Record<string, unknown>>(table: AnyTable, pkColumn: string, row: Row): void {
  if (!(pkColumn in row) || row[pkColumn] === null || row[pkColumn] === undefined) {
    throw new Error(`Row for ${table.$name} is missing primary key ${pkColumn}`)
  }
}

export class UnitOfWork {
  private readonly identityMap = new Map<string, Tracked<Record<string, unknown>>>()

  constructor(
    private readonly session: SqlSession,
    private readonly dialect: Dialect,
    private readonly tx: TransactionManager = new TransactionManager(session),
  ) {}

  attach<Row extends Record<string, unknown>>(table: AnyTable, pkColumn: string, row: Row): Row {
    requirePkColumn(table, pkColumn)
    requireRowHasPk(table, pkColumn, row)
    const key = entityKey(table, row[pkColumn])
    const existing = this.identityMap.get(key)
    if (existing) {
      if (existing.state === 'removed') throw new Error(`${key} is scheduled for removal`)
      return existing.row as Row
    }
    this.identityMap.set(key, { table, pkColumn, row, snapshot: { ...row }, state: 'clean' })
    return row
  }

  registerNew<Row extends Record<string, unknown>>(table: AnyTable, pkColumn: string, row: Row): Row {
    requirePkColumn(table, pkColumn)
    requireRowHasPk(table, pkColumn, row)
    const key = entityKey(table, row[pkColumn])
    if (this.identityMap.has(key)) throw new Error(`${key} is already tracked`)
    this.identityMap.set(key, { table, pkColumn, row, snapshot: { ...row }, state: 'new' })
    return row
  }

  remove(table: AnyTable, pkColumn: string, pkValue: unknown): void {
    const key = entityKey(table, pkValue)
    const tracked = this.identityMap.get(key)
    if (!tracked) throw new Error(`Cannot remove untracked entity ${key}`)
    // A 'new' entity was never flushed, so there's no row to DELETE; just drop it.
    if (tracked.state === 'new') this.identityMap.delete(key)
    else tracked.state = 'removed'
  }

  isTracked(table: AnyTable, pkValue: unknown): boolean {
    return this.identityMap.has(entityKey(table, pkValue))
  }

  flush(): number {
    const inserts: Tracked<Record<string, unknown>>[] = []
    const updates: { tracked: Tracked<Record<string, unknown>>; columns: string[] }[] = []
    const deletes: Tracked<Record<string, unknown>>[] = []
    for (const tracked of this.identityMap.values()) {
      if (tracked.state === 'new') inserts.push(tracked)
      else if (tracked.state === 'removed') deletes.push(tracked)
      else {
        const columns = this.dirtyColumns(tracked)
        if (columns.length > 0) updates.push({ tracked, columns })
      }
    }
    if (inserts.length === 0 && updates.length === 0 && deletes.length === 0) return 0
    return this.tx.run(() => {
      for (const tracked of inserts) this.insert(tracked)
      for (const { tracked, columns } of updates) this.update(tracked, columns)
      // Reverse registration order is a cheap FK-safety heuristic, not a real dependency graph.
      for (const tracked of [...deletes].reverse()) this.delete(tracked)
      for (const tracked of inserts) {
        tracked.state = 'clean'
        tracked.snapshot = { ...tracked.row }
      }
      for (const { tracked } of updates) tracked.snapshot = { ...tracked.row }
      for (const tracked of deletes) this.identityMap.delete(entityKey(tracked.table, tracked.row[tracked.pkColumn]))
      return inserts.length + updates.length + deletes.length
    })
  }

  private dirtyColumns(tracked: Tracked<Record<string, unknown>>): string[] {
    const changed: string[] = []
    for (const key of Object.keys(tracked.row)) {
      if (key === tracked.pkColumn) continue
      if (!valuesEqual(tracked.row[key], tracked.snapshot[key])) changed.push(key)
    }
    return changed
  }

  private ph(n: number): string {
    return this.dialect === 'sqlite' ? '?' : `$${n}`
  }

  private insert(tracked: Tracked<Record<string, unknown>>): void {
    const columns = Object.keys(tracked.row)
    const placeholders = columns.map((_, i) => this.ph(i + 1))
    const values = columns.map((c) => encodeValue(tracked.row[c], this.dialect))
    this.session.exec(
      `INSERT INTO ${quoteIdent(tracked.table.$name)} (${columns.map(quoteIdent).join(', ')}) VALUES (${placeholders.join(', ')})`,
      values,
    )
  }

  private update(tracked: Tracked<Record<string, unknown>>, columns: string[]): void {
    const setSql = columns.map((c, i) => `${quoteIdent(c)} = ${this.ph(i + 1)}`).join(', ')
    const values = columns.map((c) => encodeValue(tracked.row[c], this.dialect))
    values.push(encodeValue(tracked.row[tracked.pkColumn], this.dialect))
    this.session.exec(
      `UPDATE ${quoteIdent(tracked.table.$name)} SET ${setSql} WHERE ${quoteIdent(tracked.pkColumn)} = ${this.ph(columns.length + 1)}`,
      values,
    )
  }

  private delete(tracked: Tracked<Record<string, unknown>>): void {
    this.session.exec(
      `DELETE FROM ${quoteIdent(tracked.table.$name)} WHERE ${quoteIdent(tracked.pkColumn)} = ${this.ph(1)}`,
      [encodeValue(tracked.row[tracked.pkColumn], this.dialect)],
    )
  }
}
