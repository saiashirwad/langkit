# langkit

TypeScript 7 (`tsgo`) added content mappers, which let an external process tell the compiler what a non-TypeScript file means. Node 24.2+ added synchronous module loader hooks (`module.registerHooks`). `langkit` is a library for building small languages that plug into both.

Instead of running a codegen step that writes `.d.ts` and `.js` files to disk, you write a parser, a checker, and a projection. When TypeScript sees an import of your file, the content mapper returns virtual TypeScript declarations mapped back to the byte spans of your source file. When Node runs the program, the loader compiles the file in memory.

Here is an excerpt from [`examples/schema/blog.schema`](examples/schema/blog.schema):

```
let published = fn(q) => q |> where .status == PostStatus.Published

model User = {
  id : Int |> primaryKey |> autoIncrement,
  email : String |> unique,
  role : Role |> default Role.Member
}

query userByEmail(email: User.email) =
  User |> where .email == email |> first

query feed(n: Int, before: DateTime?) =
  Post
    |> published
    |> where before == null or .createdAt < before
    |> limit n
    |> select {
      .id,
      .title,
      author: .author |> select { .id, .email }
    }
```

And [`examples/typescript/blog.ts`](examples/typescript/blog.ts) importing it:

```typescript
import { open } from "../schema/blog.schema";

const db = open(":memory:");
db.init();

const me = db.userByEmail({ email: "sai@example.com" }); // User | undefined
for (const post of db.feed({ n: 10, before: null })) {
  console.log(post.title, post.author.email);
}
```

In the editor, hovering `db.userByEmail` shows its parameter and return types along with the compiled SQL query. Go-to-definition on `userByEmail` or `post.title` jumps to the corresponding line in `blog.schema`. If you break a query in `blog.schema`, `tsgo` reports the diagnostic on that span.

## Running the repo

Requires Node.js 24.2+, pnpm, and `typescript@7.1.0-beta`.

```sh
pnpm install
pnpm typecheck
pnpm test
node --import ./examples/register.ts examples/typescript/blog.ts
node --import ./examples/register.ts examples/typescript/checkout.ts
```

## Building a language

A hosted language implements `HostLanguage`: a file extension and a `host(source, uri)` function. `host` parses and checks the source and returns three fields:

- `declarations` is an array of strings and source-mapped pieces (`verbatim` or `atom`). `project(declarations)` turns them into `.d.ts` text plus the offset mapping table that `tsgo` uses for hover, references, and go-to-definition. Use `verbatim(text, span)` when an identifier in the `.d.ts` matches the guest source character-for-character; use `atom(text, span)` when projecting a synthesized declaration whose text differs from the source span.
- `javascript` is a `() => string` thunk that emits the runtime ES module. `tsgo` never calls it, so typechecking in the editor does not pay for code generation.
- `diagnostics` is the list of parse or check errors to report in the guest file.

Here is a complete language for `.calc` files with `let` bindings, arithmetic, comparisons, error recovery across declarations, source-mapped `.d.ts` exports, and ES module emission:

```ts
import { bind, type Check, check, fail, lookup, pure, run, scoped, type Span } from "langkit";
import { type HostLanguage, type Piece, project, unhosted, verbatim } from "langkit/host";
import * as ir from "langkit/ir";
import { emitModule } from "langkit/javascript";
import {
  choice,
  commit,
  createLexemes,
  type Located,
  located as locate,
  many1,
  named,
  type Parser,
  parser,
  parseResult,
  precedence,
  regex,
} from "langkit/parse";
import assert from "node:assert/strict";

type Type = "number" | "boolean";
type Syntax =
  | { readonly kind: "literal"; readonly type: Type; readonly value: number | boolean; }
  | { readonly kind: "name"; readonly name: string; }
  | {
    readonly kind: "binary";
    readonly op: "+" | "-" | "*" | ">";
    readonly left: Expr;
    readonly right: Expr;
  };
type Expr = Located<Syntax>;
type Decl = { readonly name: string; readonly nameSpan: Span; readonly value: Expr; };

const located = locate<Syntax>;
const lex = createLexemes({
  trivia: regex(/\s*/),
  identifier: /[a-zA-Z_]\w*/,
  keywords: ["let", "true", "false"],
});
const id = named(lex.identifier);

const atom: Parser<Expr> = choice(
  located(lex.token(regex(/\d+/)).map((text) => ({ kind: "literal", type: "number", value: Number(text) }))),
  located(lex.keyword("true").map(() => ({ kind: "literal", type: "boolean", value: true }))),
  located(lex.keyword("false").map(() => ({ kind: "literal", type: "boolean", value: false }))),
  id.map(({ name, span }): Expr => ({ kind: "name", name, span })),
);
const operator = (op: "+" | "-" | "*" | ">") =>
  lex.symbol(op).map(() => (left: Expr, right: Expr): Expr => ({
    kind: "binary",
    op,
    left,
    right,
    span: { start: left.span.start, end: right.span.end },
  }));
const expr = precedence(atom, [
  { associativity: "left", operator: operator("*") },
  { associativity: "left", operator: choice(operator("+"), operator("-")) },
  { associativity: "left", operator: operator(">") },
]);
const declaration = parser(function*() {
  yield* lex.keyword("let");
  yield* commit();
  const target = yield* id;
  yield* lex.symbol("=");
  return { name: target.name, nameSpan: target.span, value: yield* expr };
});
const program = lex.complete(many1(declaration));

const env = scoped<ReadonlyMap<string, ir.Binding<Type>>>(new Map());

const expect = (value: ir.Value<Type>, expected: Type): Check<void> =>
  value.type === expected
    ? pure(undefined)
    : fail(`Expected ${expected}, got ${value.type}`).at(value.span).recover();

const checkExpr = (node: Expr): Check<ir.Value<Type>> =>
  check(function*() {
    switch (node.kind) {
      case "literal":
        return ir.literal(node.type, node.value);
      case "name":
        return ir.ref(yield* lookup(env, node.name));
      case "binary": {
        const left = yield* checkExpr(node.left);
        const right = yield* checkExpr(node.right);
        yield* expect(left, "number");
        yield* expect(right, "number");
        return ir.binary(node.op === ">" ? "boolean" : "number", node.op, left, right);
      }
    }
  }).map((value) => ir.at(value, node.span)).at(node.span);

const checkDecls = (decls: readonly Decl[]): Check<ir.Value<Type>> =>
  check(function*() {
    const [first, ...rest] = decls;
    const initial = yield* checkExpr(first!.value);
    const ref = yield* ir.declare(first!.name, initial);
    return rest.length === 0 ? ref : yield* bind(env, [[first!.name, ref.binding]], checkDecls(rest));
  });

const calc: HostLanguage = {
  extension: ".calc",
  host: (source) => {
    const parsed = parseResult(program, source);
    if (!parsed.success) return unhosted(parsed.errors);
    const checked = run(ir.body(checkDecls(parsed.value)));
    if (!checked.success) return unhosted(checked.errors);
    const body = checked.value;
    const exports = parsed.value.map((decl, i) => [decl, body.declarations[i]!.binding] as const);
    return {
      declarations: exports.flatMap(([decl, binding]): readonly Piece[] => [
        "export declare const ",
        verbatim(decl.name, decl.nameSpan),
        `: ${binding.type};\n`,
      ]),
      javascript: () =>
        emitModule({
          imports: [],
          body,
          exports: exports.map(([decl, binding]) => [decl.name, binding]),
        }),
      diagnostics: [],
    };
  },
};

const hosted = calc.host("let subtotal = 85 + 40\nlet freeShipping = subtotal > 100\n", "file:///shop.calc");
const projected = project(hosted.declarations);
assert.equal(
  projected.text,
  "export declare const subtotal: number;\nexport declare const freeShipping: boolean;\n",
);
assert.deepEqual(projected.mappings, [
  [21, 8, 4, 8, 0], // "subtotal" in .d.ts -> "subtotal" in .calc
  [60, 12, 27, 12, 0], // "freeShipping" in .d.ts -> "freeShipping" in .calc
]);
assert.equal(
  hosted.javascript?.(),
  [
    "const _subtotal_0 = (85 + 40);",
    "const _freeShipping_1 = (_subtotal_0 > 100);",
    "export { _subtotal_0 as \"subtotal\", _freeShipping_1 as \"freeShipping\" };",
    "export default _freeShipping_1;",
    "",
  ].join("\n"),
);

const bad = calc.host("let a = 1 + true\nlet b = false > 0\n", "file:///shop.calc");
assert.deepEqual(
  bad.diagnostics.map((d) => d.message),
  ["Expected number, got boolean", "Expected number, got boolean"],
);
```

## Wiring up TypeScript and Node

Serve your `HostLanguage` list from two small scripts, one for `tsgo` and one for Node:

```typescript
// content-mapper.ts
import { serveContentMapper } from "langkit/host/content-mapper";
serveContentMapper([calc]);

// register.ts
import { registerHostLanguages } from "langkit/host/loader";
registerHostLanguages([calc]);
```

TypeScript finds content mappers through a package with a `typescript.contentMapper` entry in its `package.json` (see [`content-mapper/package.json`](content-mapper/package.json)):

```json
{
  "name": "my-content-mapper",
  "typescript": {
    "contentMapper": {
      "exec": ["node", "./content-mapper.ts"],
      "dynamicConfig": true
    }
  }
}
```

List that package and the file extensions it handles in `tsconfig.json`:

```json
{
  "contentMappers": [
    {
      "package": "my-content-mapper",
      "extensions": [".calc"]
    }
  ]
}
```

Content mappers execute external code, so pass `--runExternalCode` to `tsc` and set `initializationOptions: { runExternalCode: true }` in your editor's TypeScript LSP config. `tsc` checks mapped files without emitting `.js` for them; at runtime, run Node with `--import ./register.ts`.

When one guest file imports another, emit a real `import` or `import type` statement in `declarations` using `specifier(fromUri, toUri)`. That gives `tsgo` the dependency edge so editing an imported guest file rechecks its dependents immediately, even before saving. `serveContentMapper` also watches every guest file in the project on `openProject`, so saving a file invalidates cached transforms.

## Library layout

The modules in `src/` can be used together or picked individually:

`langkit` (`src/check.ts`, `src/diagnostic.ts`) provides `Check<A>`, a generator-based checker (`check(function*() { ... })`) evaluated on an explicit continuation stack so deep syntax trees do not overflow the call stack. It handles lexical environments (`scoped`, `within`, `bind`, `lookup`), source spans and context breadcrumbs (`.at(span)`, `.context(label)`), error recovery (`check.recover()` records a diagnostic and continues with a fallback value), and journaled state rollback (`transaction` and `.atomic()`).

`langkit/parse` (`src/parse.ts`) re-exports [`parserator`](https://www.npmjs.com/package/parserator), wraps parse errors into `langkit`'s `Result<T>` (`parseResult`, `parsePrefixResult`), and adds `located` and `named` span helpers.

`langkit/ir` and `langkit/javascript` (`src/ir.ts`, `src/javascript.ts`) define a small expression and module IR (`literal`, `data`, `ref`, `binary`, `call`, `fn`, `conditional`, `record`, `field`, `variant`, `match`) and its JavaScript emitter (`emit`, `emitModule`). Because `ir.declare` is a `Check` backed by `transaction`, checking and IR construction happen in a single pass inside `ir.body(...)`.

`langkit/types/higher-rank` and `langkit/types/typescript` (`src/types/higher-rank.ts`, `src/types/typescript.ts`) implement Hindley–Milner type inference with let-generalization, extensible record rows with `lacks` constraints, parameterized algebraic data types, and higher-rank `forall` polymorphism. Unification mutates type variables and row constraints through `transaction`, so failed unifications roll back cleanly. `langkit/types/typescript` formats inferred types as TypeScript type syntax or reports why a type cannot be represented in TypeScript.

`langkit/modules` (`src/modules.ts`) loads multi-file guest module graphs (`loadModules`), checks for import cycles, blanks import directives without shifting source offsets, and routes diagnostics from transitive imports back to the `import` span that pulled them in.

`langkit/analysis` and `langkit/lsp` (`src/analysis.ts`, `src/lsp.ts`) are optional. Content mappers give TypeScript callers hover and go-to-definition on exported symbols, but they do not provide syntax highlighting or local hover inside the guest file itself. `langkit/analysis` collects local definitions, references, expression types, and semantic tokens during checking (`create()`), and `langkit/lsp` serves them over stdio as a language server (`serve(analyze, show)`).

## Examples

[`examples/`](examples) contains six languages, and [`examples/typescript/`](examples/typescript) imports all six:

| Language                      | Files                                                                                                               | What it covers                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Schema](examples/schema)     | `.schema` → [`blog.ts`](examples/typescript/blog.ts), [`schema.ts`](examples/typescript/schema.ts)                  | Models, pipeline queries (`where`, `orderBy`, `limit`, `select`, `insert`, `update`, `delete`), higher-order schema helpers, SQLite DDL/SQL generation, and a `node:sqlite` runtime.                       |
| [Domain](examples/domain)     | `.domain` → [`checkout.ts`](examples/typescript/checkout.ts), [`shop.ts`](examples/typescript/shop.ts)              | Branded scalars, records, tagged unions, state machines, and multi-machine systems with `sync` events and `never` / `possible` / `~>` properties proved at compile time by a model checker.                |
| [Grammar](examples/grammar)   | `.grammar` → [`expr.ts`](examples/typescript/expr.ts), [`domain-grammar.ts`](examples/typescript/domain-grammar.ts) | Parser generator with precedence tables, cuts (`~`), separated lists, dead-rule analysis, and self-hosting ([`grammar.grammar`](examples/grammar/grammar.grammar)), projecting a parser and its AST types. |
| [Advanced](examples/advanced) | `.advanced` → [`advanced.ts`](examples/typescript/advanced.ts)                                                      | Algebraic data types, exhaustive pattern matching, row-polymorphic records, higher-rank `forall` annotations, and cross-file imports (`import "./stdlib.advanced"`).                                       |
| [HM](examples/hm)             | `.hm` → [`hm.ts`](examples/typescript/hm.ts)                                                                        | Hindley–Milner inference in ~280 lines, projecting inferred polymorphic functions to generic TypeScript signatures.                                                                                        |
| [Toy](examples/toy)           | `.toy` → [`toy.ts`](examples/typescript/toy.ts)                                                                     | The smallest end-to-end language in the repo: explicitly typed functions, `let`, `if`, and arithmetic.                                                                                                     |

Each language also has a standalone CLI (`pnpm schema`, `pnpm domain`, `pnpm grammar`, `pnpm advanced`, `pnpm hm`, `pnpm toy`) and a language server (`pnpm <name>:lsp`). [`.nvim.lua`](.nvim.lua) wires the guest LSPs and `tsgo` into Neovim.
