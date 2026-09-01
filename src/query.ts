import { isColRef, quoteIdent, type AnyTable, type ColRef } from './schema'

export type Dialect = 'postgres' | 'sqlite'

export type PreparedQuery<TRow> = {
  sql: string
  params: unknown[]
  dialect: Dialect
  rowType?: TRow
}

type CmpOp = '=' | '<>' | '>' | '>=' | '<' | '<='

type Operand = { kind: 'col'; col: ColRef<unknown> } | { kind: 'val'; value: unknown }

export type Predicate =
  | { kind: 'cmp'; op: CmpOp; left: ColRef<unknown>; right: Operand }
  | { kind: 'nullcheck'; left: ColRef<unknown>; negated: boolean }
  | { kind: 'in'; left: ColRef<unknown>; values: unknown[] }
  | { kind: 'like'; left: ColRef<unknown>; pattern: string }
  | { kind: 'and'; parts: Predicate[] }
  | { kind: 'or'; parts: Predicate[] }
  | { kind: 'not'; pred: Predicate }

function rejectNullish(value: unknown, context: string): void {
  if (value === null || value === undefined) {
    throw new Error(`${context}: SQL NULL needs isNull()/isNotNull(); equality with NULL is never true`)
  }
}

function operand<T>(right: ColRef<T> | T, context: string): Operand {
  if (isColRef(right)) return { kind: 'col', col: right }
  rejectNullish(right, context)
  return { kind: 'val', value: right }
}

function cmp(op: CmpOp, context: string) {
  return <T>(left: ColRef<T>, right: ColRef<T> | T): Predicate => ({
    kind: 'cmp',
    op,
    left,
    right: operand(right, context),
  })
}

export const eq = cmp('=', 'eq')
export const ne = cmp('<>', 'ne')
export const gt = cmp('>', 'gt')
export const gte = cmp('>=', 'gte')
export const lt = cmp('<', 'lt')
export const lte = cmp('<=', 'lte')

export function isNull<T>(left: ColRef<T>): Predicate {
  return { kind: 'nullcheck', left, negated: false }
}

export function isNotNull<T>(left: ColRef<T>): Predicate {
  return { kind: 'nullcheck', left, negated: true }
}

export function inList<T>(left: ColRef<T>, values: readonly T[]): Predicate {
  for (const value of values) rejectNullish(value, 'inList')
  return { kind: 'in', left, values: [...values] }
}

export function like(left: ColRef<string>, pattern: string): Predicate {
  rejectNullish(pattern, 'like')
  return { kind: 'like', left, pattern }
}

export function and(...parts: Predicate[]): Predicate {
  return { kind: 'and', parts }
}

export function or(...parts: Predicate[]): Predicate {
  return { kind: 'or', parts }
}

export function not(pred: Predicate): Predicate {
  return { kind: 'not', pred }
}

class Binder {
  readonly params: unknown[] = []
  constructor(private readonly dialect: Dialect) {}

  push(value: unknown): string {
    this.params.push(value)
    if (this.dialect === 'sqlite') return '?'
    return `$${this.params.length}`
  }
}

function colSql(col: ColRef<unknown>): string {
  return `${quoteIdent(col.table)}.${quoteIdent(col.column)}`
}

function compileOperand(right: Operand, bind: Binder): string {
  return right.kind === 'col' ? colSql(right.col) : bind.push(right.value)
}

function compilePred(pred: Predicate, bind: Binder): string {
  switch (pred.kind) {
    case 'cmp':
      return `${colSql(pred.left)} ${pred.op} ${compileOperand(pred.right, bind)}`
    case 'nullcheck':
      return `${colSql(pred.left)} IS ${pred.negated ? 'NOT NULL' : 'NULL'}`
    case 'in':
      // IN () is invalid SQL; empty membership is false.
      if (pred.values.length === 0) return '1 = 0'
      return `${colSql(pred.left)} IN (${pred.values.map((value) => bind.push(value)).join(', ')})`
    case 'like':
      return `${colSql(pred.left)} LIKE ${bind.push(pred.pattern)}`
    case 'and':
      if (pred.parts.length === 0) return '1 = 1'
      return `(${pred.parts.map((part) => compilePred(part, bind)).join(' AND ')})`
    case 'or':
      if (pred.parts.length === 0) return '1 = 0'
      return `(${pred.parts.map((part) => compilePred(part, bind)).join(' OR ')})`
    case 'not':
      return `(NOT ${compilePred(pred.pred, bind)})`
  }
}

type JoinKind = 'INNER' | 'LEFT'
type JoinClause = { kind: JoinKind; tableName: string; alias: string; on: Predicate }
type OrderClause = { col: ColRef<unknown>; dir: 'ASC' | 'DESC' }

type SelectShape = Record<string, ColRef<unknown>>

export type InferRow<S extends SelectShape> = {
  [K in keyof S]: S[K] extends ColRef<infer T> ? T : never
}

type QueryState = {
  fromName: string
  fromAlias: string
  joins: readonly JoinClause[]
  where: Predicate | undefined
  select: SelectShape | undefined
  orderBy: readonly OrderClause[]
  limit?: number
  offset?: number
}

function aliasesOf(state: QueryState): Set<string> {
  return new Set([state.fromAlias, ...state.joins.map((join) => join.alias)])
}

function requireCount(n: number, label: string): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label}() expects a non-negative integer, got ${String(n)}`)
  }
  return n
}

export class SelectQuery<TRow> {
  private constructor(private readonly state: QueryState) {}

  static start(table: AnyTable): SelectQuery<never> {
    return new SelectQuery({
      fromName: table.$name,
      fromAlias: table.$alias,
      joins: [],
      where: undefined,
      select: undefined,
      orderBy: [],
      limit: undefined,
      offset: undefined,
    })
  }

  innerJoin(table: AnyTable, on: Predicate): SelectQuery<TRow> {
    return this.addJoin('INNER', table, on)
  }

  leftJoin(table: AnyTable, on: Predicate): SelectQuery<TRow> {
    return this.addJoin('LEFT', table, on)
  }

  where(pred: Predicate): SelectQuery<TRow> {
    const where = this.state.where ? and(this.state.where, pred) : pred
    return new SelectQuery({ ...this.state, where })
  }

  select<S extends SelectShape>(shape: S): SelectQuery<InferRow<S>> {
    if (this.state.select) {
      throw new Error('select() already called')
    }
    const keys = Object.keys(shape)
    if (keys.length === 0) {
      throw new Error('select() needs at least one column')
    }
    for (const key of keys) quoteIdent(key)
    return new SelectQuery({ ...this.state, select: shape })
  }

  orderBy(col: ColRef<unknown>, dir: 'asc' | 'desc' = 'asc'): SelectQuery<TRow> {
    return new SelectQuery({
      ...this.state,
      orderBy: [...this.state.orderBy, { col, dir: dir === 'desc' ? 'DESC' : 'ASC' }],
    })
  }

  limit(n: number): SelectQuery<TRow> {
    return new SelectQuery({ ...this.state, limit: requireCount(n, 'limit') })
  }

  offset(n: number): SelectQuery<TRow> {
    return new SelectQuery({ ...this.state, offset: requireCount(n, 'offset') })
  }

  compile(dialect: Dialect = 'postgres'): PreparedQuery<TRow> {
    const shape = this.state.select
    if (!shape) {
      throw new Error('compile() requires select()')
    }
    const bind = new Binder(dialect)
    const projections = Object.keys(shape).map((alias) => {
      const col = shape[alias]
      if (!col) throw new Error(`Missing select column ${alias}`)
      return `${colSql(col)} AS ${quoteIdent(alias)}`
    })
    const fromSql = `FROM ${quoteIdent(this.state.fromName)} AS ${quoteIdent(this.state.fromAlias)}`
    const joinSql = this.state.joins.map((join) => {
      return `${join.kind} JOIN ${quoteIdent(join.tableName)} AS ${quoteIdent(join.alias)} ON ${compilePred(join.on, bind)}`
    })
    const parts = [`SELECT ${projections.join(', ')}`, fromSql, ...joinSql]
    if (this.state.where) parts.push(`WHERE ${compilePred(this.state.where, bind)}`)
    if (this.state.orderBy.length > 0) {
      const order = this.state.orderBy.map((item) => `${colSql(item.col)} ${item.dir}`).join(', ')
      parts.push(`ORDER BY ${order}`)
    }
    if (this.state.limit !== undefined) parts.push(`LIMIT ${bind.push(this.state.limit)}`)
    if (this.state.offset !== undefined) parts.push(`OFFSET ${bind.push(this.state.offset)}`)
    return { sql: parts.join('\n'), params: bind.params, dialect }
  }

  private addJoin(kind: JoinKind, table: AnyTable, on: Predicate): SelectQuery<TRow> {
    if (aliasesOf(this.state).has(table.$alias)) {
      throw new Error(`Join alias ${JSON.stringify(table.$alias)} is already in the query`)
    }
    return new SelectQuery({
      ...this.state,
      joins: [...this.state.joins, { kind, tableName: table.$name, alias: table.$alias, on }],
    })
  }
}

export function from(table: AnyTable): SelectQuery<never> {
  return SelectQuery.start(table)
}
