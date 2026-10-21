# Functional SQLite schemas

Schema is a schema compiler, not an ORM. It checks field blocks and pure model transformations, then compiles a checked schema representation to SQLite DDL. It shares langkit parsing, checking, and source analysis, but its result is a schema—not the portable expression IR used by expression languages. The implementation is [schema.ts](./schema.ts); [main.schema](./main.schema) is the large example and [simple.schema](./simple.schema) the compact teaching example.

```sh
pnpm schema                         # print SQL for main.schema
pnpm schema path/to/database.schema
pnpm schema:lsp                     # language server over stdio
```

## A small teaching schema

[simple.schema](./simple.schema) defines explicit enums, User and Post models, primary keys, a foreign key, an index, and pure transformations for timestamps and authorship. The helpers are defined in source; there is no built-in timestamp feature.

The language uses declarations such as `type Role = Member | Admin` and `model User = { ... }`. Scalar field types are `Int`, `Float`, `String`, `Bool`, and `DateTime`; a trailing `?` allows SQL NULL. Operations on fields include `primaryKey`, `autoIncrement`, `unique`, `default value`, and `references Model.field`. Model operations include `extend { ... }`, `index [.field, ...]`, `unique [.field, ...]`, and named pure helpers. Enum values are qualified (for example, `Role.Member`). A field pipe transforms one field description; a model pipe transforms a model description. Neither performs database operations.

```schema
let timestamps = fn(model) =>
  model |> extend {
    createdAt : DateTime |> default now,
    updatedAt : DateTime |> default now
  }

type Role = Member | Admin

model User = {
  id : Int |> primaryKey |> autoIncrement,
  role : Role |> default Role.Member
} |> timestamps
```

Helpers are source-defined unary functions of the form `let name = fn(parameter) => ...`; they may call other helpers, including forward declarations, but cannot recurse. `extend` only adds fields; collisions (including SQLite case-insensitive collisions) are errors. The [full source](./main.schema) also demonstrates foreign keys, composite uniqueness, indexes, reusable authorship and soft-delete transformations, and explicit join models.

## Reading the larger schema

[main.schema](./main.schema) is a publishing-platform example with **190 models and 53 enums**, across these areas:

| Area       |  Models |  Enums |
| ---------- | ------: | -----: |
| Publishing |      19 |      7 |
| Editorial  |      43 |      8 |
| Community  |      43 |     13 |
| Commerce   |      43 |     17 |
| Operations |      42 |      8 |
| **Total**  | **190** | **53** |

The large source comments identify application-level rules, such as requiring related records to belong to the same publication or preventing reply cycles. Those invariants are not silently supplied by the schema compiler.

## SQLite semantics and limits

Fields are comma-separated (optional trailing comma); declarations need no semicolons; `//` starts a comment. Fields are required by default; `?` makes them nullable. SQLite representations are: `Int` → `INTEGER`, `Float` → `REAL`, `String` → `TEXT`, `Bool` → `INTEGER` with a 0/1 check, `DateTime` → `TEXT`, and declared enums → `TEXT` with a check for declared members. Tables use SQLite `STRICT` mode (SQLite 3.37+). `DateTime` is a storage convention, not validated timestamp syntax; `default now` emits `CURRENT_TIMESTAMP`.

Defaults accept matching number/string/boolean literals, qualified enum values, or `now` for `DateTime`. Integer defaults must be safe integers; there is no literal NULL default or literal DateTime default. `autoIncrement` requires an `Int` primary key and cannot accompany a default; it adds SQLite's no-rowid-reuse guarantee. Foreign keys are explicit scalar fields, require the target's declared type, and must reference a primary key or individually unique field. `references User.id as author` also names a to-one relation, nullable when the key is `?`. A model names the reverse with `|> many posts = Post.author`, or `|> one profile = Profile.user` when the key is unique. There are no implicit relations, composite foreign keys, or referential-action modifiers. Nullable references and SQLite's default NO ACTION behavior remain.

`compile(source)` returns `{ schema, sql }` on success and diagnostics on failure; SQL is not produced when checking has errors. `analyze(source)` reports diagnostics, field/type hovers, and definitions for enum values, helper calls, foreign keys, and index selectors; it neither generates SQL nor opens a database. Helper field requirements are checked when applied, while field types/defaults/references and helper cycles are checked even in unused helpers. Extension fields retain their helper-source locations.

The CLI **only prints SQL** for a fresh schema. This is not a migration: it does not drop existing tables or connect to a database. SQL includes `PRAGMA foreign_keys = ON`, but an application must enable foreign keys on each connection (outside an active transaction). `updatedAt |> default now` initializes a value on insertion; it does not install an update trigger. There are no imports, arbitrary functions, payload-carrying enum variants, query builder, or ORM.

## Queries

[blog.schema](./blog.schema) declares named queries next to its models. Each one starts at a model and compiles to one SQLite statement.

```schema
query feed(n: Int, before: DateTime?) =
  Post
    |> published
    |> where before == null or .createdAt < before
    |> newestFirst
    |> limit n
    |> select {
      .id,
      .title,
      author: .author |> select { .id, .email },
      comments: .comments |> visible |> limit 2 |> select { .body, by: .author.email },
      commentCount: .comments |> visible |> count
    }
```

Reads take `where`, `orderBy`, `offset`, `limit`, `select`, and end in rows, `first`, `count`, or `exists`. Writes are `insert`, `update`, and `delete`, with an optional `returning`. A parameter is typed by a scalar, an enum, or a field such as `User.id`, which carries the key brand. Helpers like `published` may filter, order, and page.

The checker rejects `first` without `orderBy` or a unique match, `update` or `delete` without `where`, an `insert` missing a required field, an unused parameter, a comparison between different keys, and `== null` on a value that is never null. Each error points at the guest source.

Imported from TypeScript, the schema exports `open(path)`. It returns a `Database` with one method per query, typed by the query's params and rows, plus `transaction`, `init`, and `close`. Hover on a method shows its SQL. [blog.ts](../typescript/blog.ts) runs it under `node --import ./examples/register.ts`. `open` refuses a database whose stored DDL fingerprint differs from this schema. There are no migrations.
