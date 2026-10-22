# langkit

Write a small language, then import its files from TypeScript. You get real types in the editor and real values at runtime.

```typescript
import { open } from "../schema/blog.schema";

const db = open(":memory:");
db.init();
const me = db.userByEmail({ email: "sai@example.com" }); // User | undefined
```

`blog.schema` isn't TypeScript. TypeScript 7.1's content mappers ask langkit what it means, and a node loader runs it.

Requires Node.js 24.2+, pnpm, and `typescript@7.1.0-beta`.

```sh
pnpm install
pnpm typecheck
node --import ./examples/register.ts examples/typescript/blog.ts
```

## How it works

```
blog.schema ── your checker ──┬── TypeScript declarations ── content mapper ── tsgo: types, hover, errors
                              └── JavaScript module ──────── node loader ──── values at runtime
```

A language is a `HostLanguage`: a file extension and a `host(source, uri)` function. `host` checks the file and returns three things:

- **declarations.** TypeScript text built from pieces. An `atom` or `verbatim` piece maps back to a span of your source, so hover, go-to-definition and errors land on your file.
- **javascript.** A thunk that emits the module. Only the loader calls it, so the editor never pays for emit.
- **diagnostics.** Your language's errors. tsgo shows them in the file.

```ts
import { check, fail, run } from "langkit";
import { atom, type HostLanguage, project, unhosted } from "langkit/host";
import * as ir from "langkit/ir";
import { emitModule } from "langkit/javascript";
import assert from "node:assert/strict";

const checkSource = (source: string) =>
  run(ir.body(check(function*() {
    const value = Number(source);
    if (source.trim() === "" || !Number.isFinite(value)) return yield* fail("expected a number");
    return ir.literal("number", value);
  })));

const answer: HostLanguage = {
  extension: ".answer",
  host: (source) => {
    const checked = checkSource(source);
    if (!checked.success) return unhosted(checked.errors);
    return {
      declarations: [
        "declare const ",
        atom("answer", { start: 0, end: source.length }),
        ": number;\nexport default answer;\n",
      ],
      javascript: () => emitModule({ imports: [], body: checked.value, exports: [] }),
      diagnostics: [],
    };
  },
};

const hosted = answer.host("42", "file:///project/main.answer");
assert.equal(project(hosted.declarations).text, "declare const answer: number;\nexport default answer;\n");
assert.equal(hosted.javascript?.(), "export default 42;\n");
assert.equal(answer.host("nope", "file:///project/bad.answer").diagnostics[0]?.message, "expected a number");
```

## Wiring it up

Serve your languages from a content mapper and a loader:

```typescript
// content-mapper.ts
import { serveContentMapper } from "langkit/host/content-mapper";
serveContentMapper([answer]);

// register.ts
import { registerHostLanguages } from "langkit/host/loader";
registerHostLanguages([answer]);
```

Point TypeScript at the mapper with a package that declares it, and list your extensions in `tsconfig.json`:

```json
{ "typescript": { "contentMapper": { "exec": ["node", "./content-mapper.ts"], "dynamicConfig": true } } }
```

```json
{ "contentMappers": [{ "package": "my-mapper", "extensions": [".answer"] }] }
```

Content mappers run external code, so `tsc` and the editor need `--runExternalCode`. `tsc` doesn't emit JavaScript for mapped files, which is why the loader exists: run with `node --import ./register.ts`.

When a guest file imports another one, project the import as real TypeScript. tsgo then rechecks dependents when a dependency changes, even before it's saved. The content mapper also watches every guest file, so a save re-transforms the project. [Advanced](examples/advanced) does both.

## The pieces

- **`langkit`.** `Check` generators for checkers: scoped environments, recoverable diagnostics, and `atomic` rollback.
- **`langkit/parse`.** parserator, plus `named` and `located` helpers.
- **`langkit/types/higher-rank`.** A reusable inference theory: HM, rows, data types, and higher-rank. `langkit/types/typescript` prints its types as TypeScript.
- **`langkit/ir` and `langkit/javascript`.** A small typed IR and its JavaScript emitter. `declare` is a `Check`, so declarations and diagnostics share one generator.
- **`langkit/host`.** Projection pieces, the content mapper and the loader.
- **`langkit/analysis` and `langkit/lsp`.** Optional. Your own language server for things tsgo can't do from a projection, like highlighting and hover on locals.

## Examples

| Language                      | Shows                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| [Schema](examples/schema)     | SQLite schemas and queries, with a runtime that TypeScript imports.                   |
| [Domain](examples/domain)     | Types, state machines and systems, with a model checker that proves their properties. |
| [Grammar](examples/grammar)   | Parsers and typed syntax trees from a grammar file, checked for dead rules.           |
| [Advanced](examples/advanced) | Data types, pattern matching, higher-rank types, and imports across files.            |
| [HM](examples/hm)             | Hindley–Milner inference.                                                             |
| [Toy](examples/toy)           | The smallest end-to-end language.                                                     |

[`examples/typescript`](examples/typescript) imports all six. Each language also has a CLI (`pnpm toy [file]`) and a language server (`pnpm toy:lsp`). [`.nvim.lua`](.nvim.lua) wires them into Neovim.
