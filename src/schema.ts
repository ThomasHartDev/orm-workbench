const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export function quoteIdent(name: string): string {
  if (!IDENT.test(name)) {
    throw new Error(`Invalid SQL identifier: ${JSON.stringify(name)}`)
  }
  return `"${name}"`
}

export type ColumnKind = 'text' | 'integer' | 'boolean' | 'numeric' | 'timestamptz'

export type Column<T> = {
  readonly kind: ColumnKind
  readonly _type: T
}

function col<T>(kind: ColumnKind): Column<T> {
  return { kind } as Column<T>
}

export const text = () => col<string>('text')
export const integer = () => col<number>('integer')
export const boolean = () => col<boolean>('boolean')
export const numeric = () => col<string>('numeric')
export const timestamptz = () => col<Date>('timestamptz')

export type AnyColumn = Column<unknown>

export type ColRef<T> = {
  readonly $col: true
  readonly table: string
  readonly column: string
  readonly _type: T
}

export function isColRef(value: unknown): value is ColRef<unknown> {
  return typeof value === 'object' && value !== null && (value as { $col?: unknown }).$col === true
}

export type ColumnMap = Record<string, AnyColumn>

type ColRefs<Cols extends ColumnMap> = {
  readonly [K in keyof Cols]: ColRef<Cols[K] extends Column<infer T> ? T : never>
}

export type AnyTable = {
  readonly $name: string
  readonly $alias: string
  readonly $columns: ColumnMap
}

export type Table<Name extends string = string, Cols extends ColumnMap = ColumnMap, Alias extends string = string> =
  AnyTable & { readonly $name: Name; readonly $alias: Alias; readonly $columns: Cols } & ColRefs<Cols>

function refsFor(alias: string, columns: ColumnMap): Record<string, ColRef<unknown>> {
  quoteIdent(alias)
  const refs: Record<string, ColRef<unknown>> = {}
  for (const column of Object.keys(columns)) {
    quoteIdent(column)
    refs[column] = { $col: true, table: alias, column } as ColRef<unknown>
  }
  return refs
}

export function defineTable<Name extends string, Cols extends ColumnMap>(
  name: Name,
  columns: Cols,
): Table<Name, Cols, Name> {
  quoteIdent(name)
  return {
    $name: name,
    $alias: name,
    $columns: columns,
    ...refsFor(name, columns),
  } as Table<Name, Cols, Name>
}

export function alias<Name extends string, Cols extends ColumnMap, As extends string>(
  table: Table<Name, Cols, string>,
  as: As,
): Table<Name, Cols, As> {
  return {
    $name: table.$name,
    $alias: as,
    $columns: table.$columns,
    ...refsFor(as, table.$columns),
  } as Table<Name, Cols, As>
}
