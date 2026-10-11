# Module loading contracts

`langkit/modules` loads a local-file dependency graph without evaluating source code. The language supplies its import parser and file extension.

```ts
import { loadModules } from "langkit/modules";
import { parseImports } from "langkit/modules/imports";

const graph = loadModules(source, { uri, read }, {
  extension: "rows",
  imports: parseImports,
});
```

`parseImports` is an optional Parserator implementation of leading `import "./path";` directives. Choosing it is explicit. Other languages can supply unrelated grammars.

## Parser contract

`ImportParser` accepts the full source text and returns `Result<readonly ImportDirective[]>`. Each directive contains a relative `path` and the full directive's UTF-16 `span`.

The loader sorts directives by source position. It rejects noninteger, empty, overlapping, negative, reversed, and out-of-range spans before reading dependencies. It masks each directive with spaces, preserving line endings and UTF-16 offsets. The language parser receives the masked source.

Expected parser failures return structured diagnostics. The loader attaches the current document's identity and routes dependency failures to the importing document. Parser programming exceptions propagate.

## Graph contract

Import paths start with `./` or `../`. Targets are normalized local-file URLs without queries or fragments and must use the selected extension. The supplied `read(uri)` can return an editor's unsaved dependency snapshot. Without `read`, the loader reads files synchronously.

Modules appear in dependencies-first order. Diamond imports share one module identity and read each completed dependency once. Cycles and read failures produce diagnostics rather than partial successful graphs.

`ModuleGraph` publishes frozen module arrays, dependency arrays, and import edges. Its `sources` accessor returns a defensive map of original source snapshots. Mutating that returned map does not modify the graph.

`routeDiagnostic` preserves the original document and adds the root import path as related locations. The first root import path determines the primary presentation location through a diamond.

## Verification

`tests/modules.test.ts` covers a separate `use("path")` grammar, invalid directive spans, UTF-16 masking, immutable snapshots, diagnostic routing, and parser exceptions. `tests/example-modules.test.ts` and `tests/strict-modules.test.ts` compile real imported programs and check imported definitions and source origins.

```sh
node --test tests/modules.test.ts tests/example-modules.test.ts tests/strict-modules.test.ts
```
