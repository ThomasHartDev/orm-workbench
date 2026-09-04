# orm-workbench

A from-scratch type-safe ORM and a lab for the relational designs that break naive ORMs.

## What this demonstrates

Most ORM tutorials stop at `findMany`. This repo goes the other way. It builds the internals of a small ORM (query builder, parameter binding, later migrations, relations, and a unit of work) and then uses that machinery against schemas that are actually hard: multi-tenant isolation, bitemporal history, trees, money, and soft delete. The point is to see where typed query construction earns its keep and where you should write SQL by hand.

## Concepts demonstrated

- Relational algebra: projection (`SELECT`), selection (`WHERE`), and join
- Prepared statements and bind parameters (SQL injection resistance)
- Identifier quoting versus value binding
- SQL three-valued logic (`= NULL` is unknown; use `IS NULL`)
- Dialect-specific placeholders (`$n` for Postgres, `?` for SQLite)
- Phantom types so column refs carry their TypeScript value type
- Immutable query values (each clause returns a new builder)
- Empty `IN ()` as a false predicate, because that list is not valid SQL
- Declarative schema as a value: tables, columns, indexes, foreign keys
- Structural schema diff (desired vs current) and reverse-diff down migrations
- Topological sort of DDL from foreign-key edges, including self-references
- Migration journal with a zero-padded id prefix invariant
- Dialect type mapping (`BOOLEAN`/`TIMESTAMPTZ` vs SQLite `INTEGER`/`TEXT`)
- Expand/contract: in-place column ALTER is rejected; drop and add instead

## What's implemented

- Type-safe SELECT/WHERE/JOIN query builder with prepared-statement binding
- Declarative schema DSL + migration runner with up/down and a diff generator

## Usage

```ts
import { and, boolean, defineTable, eq, from, gt, integer, text } from 'orm-workbench'

const users = defineTable('users', {
  id: integer(),
  email: text(),
  active: boolean(),
})
const orders = defineTable('orders', {
  id: integer(),
  userId: integer(),
  totalCents: integer(),
})

const compiled = from(orders)
  .innerJoin(users, eq(orders.userId, users.id))
  .where(and(eq(users.active, true), gt(orders.totalCents, 500)))
  .select({ orderId: orders.id, email: users.email })
  .orderBy(orders.id, 'desc')
  .limit(20)
  .compile('postgres')
```

`compiled.sql` is parameterized. `compiled.params` is `[true, 500, 20]`.

Schema changes are a value you can diff. `diffSchema(from, to)` is up; `diffSchema(to, from)` is down, so a drop still knows how to recreate the table.

```ts
import { col, defineSchema, diffSchema, Migrator, table } from 'orm-workbench'

const from = defineSchema({})
const to = defineSchema({
  users: table({ id: col.integer().primaryKey(), email: col.text().unique() }).index('users_email_idx', ['email']),
  orders: table({ id: col.integer().primaryKey(), userId: col.integer().references('users', 'id', { onDelete: 'cascade' }) }),
})
new Migrator(session, 'sqlite').migrateUp([{ id: '001_init', up: diffSchema(from, to), down: diffSchema(to, from) }])
```

```bash
pnpm install
pnpm run typecheck
pnpm test
```

## License

MIT
