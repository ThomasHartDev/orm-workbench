import type { SqlSession } from './migrate'
import { from, inList, type Dialect, type InferRow, type PreparedQuery } from './query'
import { quoteIdent, type AnyTable, type ColRef } from './schema'

export type HasManyRel<As extends string = string> = {
  readonly kind: 'hasMany'
  readonly as: As
  readonly parent: AnyTable
  readonly child: AnyTable
  readonly local: ColRef<unknown>
  readonly foreign: ColRef<unknown>
}

export type BelongsToRel<As extends string = string> = {
  readonly kind: 'belongsTo'
  readonly as: As
  readonly child: AnyTable
  readonly parent: AnyTable
  readonly local: ColRef<unknown>
  readonly foreign: ColRef<unknown>
}

export type Relation = HasManyRel<string> | BelongsToRel<string>

type SelectShape = Record<string, ColRef<unknown>>

export type RelatedQueryOpts = {
  dialect?: Dialect
  orderBy?: ColRef<unknown>
  dir?: 'asc' | 'desc'
}

function requireCol(table: AnyTable, col: ColRef<unknown>, role: string): void {
  if (col.table !== table.$alias) {
    throw new Error(`${role} ${col.table}.${col.column} is not on ${table.$alias}`)
  }
  if (!(col.column in table.$columns)) {
    throw new Error(`${role} unknown column ${table.$alias}.${col.column}`)
  }
}

function colKind(table: AnyTable, col: ColRef<unknown>): string {
  const def = table.$columns[col.column]
  if (!def) throw new Error(`Unknown column ${table.$alias}.${col.column}`)
  return def.kind
}

function declareRel(
  as: string,
  owner: AnyTable,
  localTable: AnyTable,
  local: ColRef<unknown>,
  foreignTable: AnyTable,
  foreign: ColRef<unknown>,
): void {
  quoteIdent(as)
  if (as in owner.$columns) {
    throw new Error(`Relation ${JSON.stringify(as)} collides with a column on ${owner.$name}`)
  }
  requireCol(localTable, local, 'local')
  requireCol(foreignTable, foreign, 'foreign')
  const left = colKind(localTable, local)
  const right = colKind(foreignTable, foreign)
  if (left !== right) {
    throw new Error(
      `Relation columns ${local.table}.${local.column} (${left}) and ${foreign.table}.${foreign.column} (${right}) differ`,
    )
  }
}

export function hasMany<As extends string>(
  as: As,
  parent: AnyTable,
  child: AnyTable,
  local: ColRef<unknown>,
  foreign: ColRef<unknown>,
): HasManyRel<As> {
  declareRel(as, parent, parent, local, child, foreign)
  return { kind: 'hasMany', as, parent, child, local, foreign }
}

export function belongsTo<As extends string>(
  as: As,
  child: AnyTable,
  parent: AnyTable,
  local: ColRef<unknown>,
  foreign: ColRef<unknown>,
): BelongsToRel<As> {
  declareRel(as, child, child, local, parent, foreign)
  return { kind: 'belongsTo', as, child, parent, local, foreign }
}

export function uniqueKeys(values: readonly unknown[]): unknown[] {
  const seen = new Set<unknown>()
  const out: unknown[] = []
  for (const value of values) {
    if (value === null || value === undefined) continue
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function relatedTable(rel: Relation): AnyTable {
  return rel.kind === 'hasMany' ? rel.child : rel.parent
}

function assertJoinProjected(shape: SelectShape, col: ColRef<unknown>): void {
  const projected = shape[col.column]
  if (!projected || projected.table !== col.table || projected.column !== col.column) {
    throw new Error(`Select must project ${col.table}.${col.column} as ${col.column} to nest related rows`)
  }
}

function readKey(row: Record<string, unknown>, column: string, table: string): unknown {
  if (!(column in row)) {
    throw new Error(`Row is missing ${table}.${column}; project that column under its own name`)
  }
  return row[column]
}

export function relatedQuery<S extends SelectShape>(
  rel: Relation,
  keys: readonly unknown[],
  shape: S,
  opts: RelatedQueryOpts = {},
): PreparedQuery<InferRow<S>> {
  const table = relatedTable(rel)
  assertJoinProjected(shape, rel.foreign)
  if (opts.orderBy && opts.orderBy.table !== table.$alias) {
    throw new Error(`orderBy ${opts.orderBy.table}.${opts.orderBy.column} is not on ${table.$alias}`)
  }
  let query = from(table)
    .where(inList(rel.foreign as ColRef<unknown>, uniqueKeys(keys)))
    .select(shape)
  if (opts.orderBy) query = query.orderBy(opts.orderBy, opts.dir ?? 'asc')
  return query.compile(opts.dialect ?? 'postgres')
}

export function nestHasMany<As extends string, P extends Record<string, unknown>, C extends Record<string, unknown>>(
  rel: HasManyRel<As>,
  parents: readonly P[],
  children: readonly C[],
): Array<P & { [K in As]: C[] }> {
  const groups = new Map<unknown, C[]>()
  for (const child of children) {
    const key = readKey(child, rel.foreign.column, rel.child.$alias)
    if (key === null || key === undefined) continue
    const bucket = groups.get(key)
    if (bucket) bucket.push(child)
    else groups.set(key, [child])
  }
  return parents.map((parent) => {
    const key = readKey(parent, rel.local.column, rel.parent.$alias)
    const related = key === null || key === undefined ? [] : (groups.get(key) ?? [])
    return { ...parent, [rel.as]: related.slice() } as P & { [K in As]: C[] }
  })
}

export function nestBelongsTo<As extends string, C extends Record<string, unknown>, P extends Record<string, unknown>>(
  rel: BelongsToRel<As>,
  children: readonly C[],
  parents: readonly P[],
): Array<C & { [K in As]: P | null }> {
  const byId = new Map<unknown, P>()
  for (const parent of parents) {
    const key = readKey(parent, rel.foreign.column, rel.parent.$alias)
    if (key === null || key === undefined) continue
    if (!byId.has(key)) byId.set(key, parent)
  }
  return children.map((child) => {
    const key = readKey(child, rel.local.column, rel.child.$alias)
    const related = key === null || key === undefined ? null : (byId.get(key) ?? null)
    return { ...child, [rel.as]: related } as C & { [K in As]: P | null }
  })
}

export function eagerHasMany<As extends string, P extends Record<string, unknown>, S extends SelectShape>(
  session: SqlSession,
  rel: HasManyRel<As>,
  parents: readonly P[],
  childSelect: S,
  opts: RelatedQueryOpts = {},
): Array<P & { [K in As]: Array<InferRow<S>> }> {
  const keys = uniqueKeys(parents.map((parent) => readKey(parent, rel.local.column, rel.parent.$alias)))
  if (keys.length === 0) return nestHasMany(rel, parents, [])
  const compiled = relatedQuery(rel, keys, childSelect, opts)
  const children = session.all(compiled.sql, compiled.params) as Array<InferRow<S>>
  return nestHasMany(rel, parents, children)
}

export function eagerBelongsTo<As extends string, C extends Record<string, unknown>, S extends SelectShape>(
  session: SqlSession,
  rel: BelongsToRel<As>,
  children: readonly C[],
  parentSelect: S,
  opts: RelatedQueryOpts = {},
): Array<C & { [K in As]: InferRow<S> | null }> {
  const keys = uniqueKeys(children.map((child) => readKey(child, rel.local.column, rel.child.$alias)))
  if (keys.length === 0) return nestBelongsTo(rel, children, [])
  const compiled = relatedQuery(rel, keys, parentSelect, opts)
  const parents = session.all(compiled.sql, compiled.params) as Array<InferRow<S>>
  return nestBelongsTo(rel, children, parents)
}
