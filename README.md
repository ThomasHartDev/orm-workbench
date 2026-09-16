# orm-workbench

A from-scratch type-safe ORM and a lab for the relational designs that break naive ORMs.

## What this demonstrates

Most ORM tutorials stop at `findMany`. This repo goes the other way. It builds the internals of a small ORM (query builder, parameter binding, migrations, relations, and later a unit of work) and then uses that machinery against schemas that are actually hard: multi-tenant isolation, bitemporal history, trees, money, and soft delete. The point is to see where typed query construction earns its keep and where you should write SQL by hand.

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
- N+1 query problem versus batched eager loading
- `hasMany` / `belongsTo` cardinality (1:N nested arrays, N:1 nullable parent)
- Hash join in the client: `IN (...)` then group by foreign key
- Identity map so two children share one parent object
- JOIN cartesian product vs two-query nesting (parent rows are not duplicated)
- Unit of work: batches inserts/updates/deletes and flushes them as one transaction
- Session-scoped identity map so repeated loads of the same row return one object
- Snapshot-based dirty checking (diff the live object against its load-time snapshot, no proxies)
- Nested transactions via SQL `SAVEPOINT`/`RELEASE`/`ROLLBACK TO`, since real nested `BEGIN` isn't a thing
- Partial rollback: an inner failure unwinds to its savepoint without discarding the outer transaction

## What's implemented

- Type-safe SELECT/WHERE/JOIN query builder with prepared-statement binding
- Declarative schema DSL + migration runner with up/down and a diff generator
- hasMany/belongsTo relations with eager loading to kill the N+1 problem
- Unit-of-work / identity map for change tracking, with nested transactions via savepoints

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

Relations are declared once. Loading N parents then looping `WHERE userId = parent.id` is N extra queries. `eagerHasMany` compiles one `WHERE userId IN (...)` with unique keys, then nests children in memory. `belongsTo` does the inverse and reuses one parent object per id.

```ts
import { belongsTo, eagerHasMany, hasMany } from 'orm-workbench'

const userOrders = hasMany('orders', users, orders, users.id, orders.userId)
const orderUser = belongsTo('user', orders, users, orders.userId, users.id)

const graph = eagerHasMany(session, userOrders, parents, {
  id: orders.id,
  userId: orders.userId,
  totalCents: orders.totalCents,
}, { dialect: 'sqlite', orderBy: orders.id })
```

A JOIN of users to orders repeats every user column once per order. The two-query path keeps parent rows unique and attaches `orders: []` when a user has none.

A `UnitOfWork` tracks entities you load or create, batches the resulting SQL, and flushes them in one transaction. Loading the same row twice through `attach()` returns the same object instead of a second copy, and a plain field write is enough to mark it dirty: flush diffs the object against the snapshot it took at load time and only sends the columns that changed.

```ts
import { TransactionManager, UnitOfWork } from 'orm-workbench'

const tx = new TransactionManager(session)
const uow = new UnitOfWork(session, 'sqlite', tx)

const pat = uow.attach(users, 'id', session.all('SELECT * FROM users WHERE id = ?', [1])[0])
pat.email = 'pat@new.com'

const draft = uow.registerNew(orders, 'id', { id: 42, userId: 1, totalCents: 900 })
uow.flush() // one BEGIN/COMMIT: an UPDATE for pat, an INSERT for the order
```

`TransactionManager.run()` nests correctly: SQLite and Postgres don't support a second real `BEGIN`, so past the outermost call it issues `SAVEPOINT`/`RELEASE SAVEPOINT` instead. If the inner block throws, `ROLLBACK TO SAVEPOINT` undoes only that block; the outer transaction is still live and can catch the error and keep going, or commit what came before it.

```bash
pnpm install
pnpm run typecheck
pnpm test
```

## License

MIT
