import type { Dialect } from './query'
import { quoteIdent, type ColumnKind } from './schema'

export type OnDelete = 'cascade' | 'restrict' | 'set null'

export type FieldConfig = {
  readonly kind: ColumnKind
  readonly nullable: boolean
  readonly primaryKey: boolean
  readonly unique: boolean
  readonly defaultSql?: string
  readonly references?: { readonly table: string; readonly column: string; readonly onDelete: OnDelete }
}

export type FieldDef = FieldConfig & { readonly name: string }
export type IndexDef = { readonly name: string; readonly columns: readonly string[]; readonly unique: boolean }
export type TableSchema = { readonly name: string; readonly columns: readonly FieldDef[]; readonly indexes: readonly IndexDef[] }
export type DatabaseSchema = { readonly tables: readonly TableSchema[] }

export class Field {
  constructor(readonly spec: FieldConfig) {}
  nullable(): Field { return new Field({ ...this.spec, nullable: true }) }
  primaryKey(): Field { return new Field({ ...this.spec, primaryKey: true, nullable: false }) }
  unique(): Field { return new Field({ ...this.spec, unique: true }) }
  defaultSql(sql: string): Field {
    if (sql.trim() === '' || sql.includes(';')) throw new Error(`Unsafe DEFAULT expression: ${JSON.stringify(sql)}`)
    return new Field({ ...this.spec, defaultSql: sql })
  }
  references(table: string, column: string, opts?: { onDelete?: OnDelete }): Field {
    return new Field({ ...this.spec, references: { table, column, onDelete: opts?.onDelete ?? 'restrict' } })
  }
}

function of(kind: ColumnKind): Field {
  return new Field({ kind, nullable: false, primaryKey: false, unique: false })
}
export const col = {
  integer: () => of('integer'),
  text: () => of('text'),
  boolean: () => of('boolean'),
  numeric: () => of('numeric'),
  timestamptz: () => of('timestamptz'),
}
export class TableDraft {
  constructor(readonly columns: Readonly<Record<string, Field>>, readonly indexes: readonly IndexDef[] = []) {}
  index(name: string, columns: readonly string[], opts?: { unique?: boolean }): TableDraft {
    if (columns.length === 0) throw new Error(`Index ${JSON.stringify(name)} needs at least one column`)
    return new TableDraft(this.columns, [...this.indexes, { name, columns: [...columns], unique: opts?.unique === true }])
  }
}
export function table(columns: Record<string, Field>): TableDraft {
  if (Object.keys(columns).length === 0) throw new Error('table() needs at least one column')
  return new TableDraft(columns)
}
export function defineSchema(drafts: Record<string, TableDraft>): DatabaseSchema {
  const tables: TableSchema[] = []
  const indexNames = new Set<string>()
  for (const [name, draft] of Object.entries(drafts)) {
    quoteIdent(name)
    const columns: FieldDef[] = []
    let pks = 0
    const colNames = new Set<string>()
    for (const [colName, field] of Object.entries(draft.columns)) {
      quoteIdent(colName)
      colNames.add(colName)
      if (field.spec.primaryKey) pks += 1
      if (field.spec.primaryKey && field.spec.nullable) throw new Error(`Primary key ${name}.${colName} cannot be nullable`)
      if (field.spec.references?.onDelete === 'set null' && !field.spec.nullable) {
        throw new Error(`${name}.${colName} SET NULL requires a nullable column`)
      }
      if (field.spec.references) {
        quoteIdent(field.spec.references.table)
        quoteIdent(field.spec.references.column)
      }
      columns.push({ name: colName, ...field.spec })
    }
    if (pks > 1) throw new Error(`Table ${name} has ${pks} primary keys; use one`)
    const indexes: IndexDef[] = []
    for (const idx of draft.indexes) {
      quoteIdent(idx.name)
      if (indexNames.has(idx.name)) throw new Error(`Duplicate index name ${idx.name}`)
      indexNames.add(idx.name)
      for (const c of idx.columns) {
        if (!colNames.has(c)) throw new Error(`Index ${idx.name} references unknown column ${name}.${c}`)
        quoteIdent(c)
      }
      indexes.push(idx)
    }
    tables.push({ name, columns, indexes })
  }
  const byName = new Map(tables.map((t) => [t.name, t]))
  for (const t of tables) {
    for (const c of t.columns) {
      const ref = c.references
      if (!ref) continue
      const parent = byName.get(ref.table)
      if (!parent) throw new Error(`${t.name}.${c.name} references unknown table ${ref.table}`)
      const target = parent.columns.find((x) => x.name === ref.column)
      if (!target) throw new Error(`${t.name}.${c.name} references unknown column ${ref.table}.${ref.column}`)
      if (target.kind !== c.kind) {
        throw new Error(`${t.name}.${c.name} type ${c.kind} does not match ${ref.table}.${ref.column} (${target.kind})`)
      }
    }
  }
  topoTables(tables)
  return { tables }
}
export function topoTables(tables: readonly TableSchema[]): TableSchema[] {
  const byName = new Map(tables.map((t) => [t.name, t]))
  const names = tables.map((t) => t.name)
  const indeg = new Map<string, number>(names.map((n) => [n, 0]))
  const children = new Map<string, string[]>(names.map((n) => [n, []]))
  for (const t of tables) {
    const deps = new Set<string>()
    for (const c of t.columns) {
      const ref = c.references
      if (!ref || ref.table === t.name || !byName.has(ref.table)) continue
      deps.add(ref.table)
    }
    for (const parent of deps) {
      indeg.set(t.name, (indeg.get(t.name) ?? 0) + 1)
      children.get(parent)?.push(t.name)
    }
  }
  const ready = names.filter((n) => indeg.get(n) === 0)
  const ordered: string[] = []
  while (ready.length > 0) {
    const n = ready.shift()
    if (n === undefined) break
    ordered.push(n)
    for (const child of children.get(n) ?? []) {
      const next = (indeg.get(child) ?? 1) - 1
      indeg.set(child, next)
      if (next === 0) ready.push(child)
    }
  }
  if (ordered.length !== names.length) throw new Error('Foreign keys form a cycle')
  return ordered.map((n) => byName.get(n)!)
}
export type MigrationOp =
  | { kind: 'createTable'; table: TableSchema }
  | { kind: 'dropTable'; name: string }
  | { kind: 'addColumn'; table: string; column: FieldDef }
  | { kind: 'dropColumn'; table: string; column: FieldDef }
  | { kind: 'createIndex'; table: string; index: IndexDef }
  | { kind: 'dropIndex'; name: string }

function onDeleteSql(action: OnDelete): string {
  return action === 'cascade' ? 'CASCADE' : action === 'restrict' ? 'RESTRICT' : 'SET NULL'
}
function sqlType(kind: ColumnKind, dialect: Dialect): string {
  if (kind === 'timestamptz') return dialect === 'postgres' ? 'TIMESTAMPTZ' : 'TEXT'
  if (kind === 'boolean') return dialect === 'postgres' ? 'BOOLEAN' : 'INTEGER'
  return kind === 'numeric' ? 'NUMERIC' : kind === 'integer' ? 'INTEGER' : 'TEXT'
}
function columnSql(col: FieldDef, dialect: Dialect, inlineRefs: boolean): string {
  const parts = [quoteIdent(col.name), sqlType(col.kind, dialect)]
  if (!col.nullable) parts.push('NOT NULL')
  if (col.primaryKey) parts.push('PRIMARY KEY')
  if (col.unique) parts.push('UNIQUE')
  if (col.defaultSql !== undefined) parts.push(`DEFAULT ${col.defaultSql}`)
  if (inlineRefs && col.references) {
    const ref = col.references
    parts.push(`REFERENCES ${quoteIdent(ref.table)} (${quoteIdent(ref.column)}) ON DELETE ${onDeleteSql(ref.onDelete)}`)
  }
  return parts.join(' ')
}
export function compileOps(ops: readonly MigrationOp[], dialect: Dialect): string[] {
  return ops.map((op) => {
    switch (op.kind) {
      case 'createTable': {
        const body = op.table.columns.map((c) => columnSql(c, dialect, false))
        for (const c of op.table.columns) {
          if (!c.references) continue
          body.push(
            `FOREIGN KEY (${quoteIdent(c.name)}) REFERENCES ${quoteIdent(c.references.table)} (${quoteIdent(c.references.column)}) ON DELETE ${onDeleteSql(c.references.onDelete)}`,
          )
        }
        return `CREATE TABLE ${quoteIdent(op.table.name)} (\n  ${body.join(',\n  ')}\n)`
      }
      case 'dropTable':
        return `DROP TABLE ${quoteIdent(op.name)}`
      case 'addColumn':
        if (op.column.primaryKey) throw new Error('Cannot ADD COLUMN PRIMARY KEY; rebuild the table')
        if (op.column.unique && dialect === 'sqlite') throw new Error('SQLite cannot ADD COLUMN UNIQUE; add a unique index')
        if (dialect === 'sqlite' && !op.column.nullable && op.column.defaultSql === undefined) {
          throw new Error('SQLite cannot ADD COLUMN NOT NULL without DEFAULT')
        }
        return `ALTER TABLE ${quoteIdent(op.table)} ADD COLUMN ${columnSql(op.column, dialect, true)}`
      case 'dropColumn':
        if (dialect === 'sqlite') {
          if (op.column.primaryKey) throw new Error('SQLite cannot DROP COLUMN PRIMARY KEY; rebuild the table')
          if (op.column.unique) throw new Error('SQLite cannot DROP COLUMN UNIQUE; rebuild the table')
          if (op.column.references) throw new Error('SQLite cannot DROP COLUMN with a foreign key; rebuild the table')
        }
        return `ALTER TABLE ${quoteIdent(op.table)} DROP COLUMN ${quoteIdent(op.column.name)}`
      case 'createIndex': {
        const uniq = op.index.unique ? 'UNIQUE ' : ''
        return `CREATE ${uniq}INDEX ${quoteIdent(op.index.name)} ON ${quoteIdent(op.table)} (${op.index.columns.map(quoteIdent).join(', ')})`
      }
      case 'dropIndex':
        return `DROP INDEX ${quoteIdent(op.name)}`
    }
  })
}
