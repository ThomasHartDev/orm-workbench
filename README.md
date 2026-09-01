# orm-workbench

A from-scratch type-safe ORM and a lab for the relational designs that break naive ORMs.

## What this demonstrates

Most ORM tutorials stop at `findMany`. This repo goes the other way. It builds the internals of a small ORM (query builder, parameter binding, later migrations, relations, and a unit of work) and then uses that machinery against schemas that are actually hard: multi-tenant isolation, bitemporal history, trees, money, and soft delete. The point is to see where typed query construction earns its keep and where you should write SQL by hand.

## Concepts demonstrated

- Relational algebra for SELECT, projection, selection, and join
- Prepared statements and bind parameters (SQL injection resistance)
- Identifier quoting vs value binding
- SQL three-valued logic (`= NULL` is unknown)
- Dialect-specific parameter placeholders (`$1` vs `?`)

## What's implemented

- Project scaffold (TypeScript, Vitest, GitHub Actions CI)

## Usage

```ts
import { version } from 'orm-workbench'

console.log(version)
```

```bash
pnpm install
pnpm run typecheck
pnpm test
```

## License

MIT
