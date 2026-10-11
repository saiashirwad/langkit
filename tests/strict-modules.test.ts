import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { definitionAt, typeAt } from "langkit/analysis";
import { analyze, compile, show } from "../examples/strict/strict.ts";
import { loadModules } from "langkit/modules";
for (const declaration of [
  "class Monad (m : Type -> Type) where { bind : forall a. m a -> number; } instance Monad Effect where { bind action = 42; }",
  "class Monad (m : Type -> Type) where { other : forall a. m a -> m a; } instance Monad Effect where { other action = action; }",
  "class Monad a where { bind : a -> a; } instance Monad number where { bind x = x; }",
]) {
  test(`strict do validates the source Monad class: ${declaration}`, () => {
    const result = compile(
      `${declaration} main : Effect number; main = do { x <- pureEffect 1; pureEffect x; };`,
    );
    assert.equal(result.success, false);
  });
}

test("strict do rejects an incompatible Monad signature imported from a module", () => {
  const result = compile(
    'import "./monad.strict"; main : Effect number; main = do { x <- pureEffect 1; pureEffect x; };',
    {
      uri: "file:///modules/main.strict",
      read: () =>
        "class Monad (m : Type -> Type) where { bind : forall a. m a -> number; } instance Monad Effect where { bind action = 42; }",
    },
  );
  assert.equal(result.success, false);
});

const options = (files: Readonly<Record<string, string>>) => ({
  uri: "file:///modules/main.strict",
  read: (uri: string) => {
    const source = files[uri];
    if (source === undefined) throw new Error(`Missing test module: ${uri}`);
    return source;
  },
});

const parsedImportSpan = (source: string, target: string, files: Readonly<Record<string, string>>) => {
  const graph = loadModules(source, options(files), "strict");
  assert.ok(graph.success);
  const edge = graph.value.module("file:///modules/main.strict")?.imports.find((dependency) => dependency.uri === target);
  assert.ok(edge);
  return edge.span;
};
const evaluate = (source: string, files: Readonly<Record<string, string>> = {}) => {
  const result = compile(source, options(files));
  assert.ok(result.success, result.success ? "" : result.error.message);
  return runInNewContext(result.value.javascript, {}, { timeout: 1000 });
};

for (const name of ["id", "Some", "pure", "map"]) {
  test(`strict has no implicit stdlib name ${name}`, () => {
    const result = compile(`main = ${name};`, options({}));
    assert.equal(result.success, false);
  });
}

test("strict modules export polymorphic definitions and user datatypes", () => {
  const files = {
    "file:///modules/helpers.strict": "data Box a = Box a; identity x = x; boxed = Box;",
  };
  assert.equal(
    evaluate(
      'import "./helpers.strict"; main = if identity true then case boxed 42 of { Box x -> x; } else 0;',
      files,
    ),
    42,
  );
});

test("strict imported declarations need no main and export classes with instances", () => {
  const files = {
    "file:///modules/select.strict":
      "class Select a where { select : a -> a; } instance Select number where { select x = x + 1; } choose x = select x;",
  };
  assert.equal(evaluate('import "./select.strict"; main = choose 41;', files), 42);
});

test("strict imports are isolated from unrelated earlier siblings", () => {
  const source = 'import "./a.strict"; import "./b.strict"; main = bad;';
  const files = {
    "file:///modules/a.strict": "secret = 42;",
    "file:///modules/b.strict": "bad = secret;",
  };
  const result = compile(
    source,
    options(files),
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.origin?.uri, "file:///modules/b.strict");
    assert.equal(result.error.location?.uri, "file:///modules/main.strict");
    const importSpan = parsedImportSpan(source, "file:///modules/b.strict", files);
    assert.equal(importSpan.start, 'import "./a.strict"; '.length);
    assert.deepEqual(result.error.location?.span, importSpan);
    assert.equal(source.slice(importSpan.start, importSpan.end).trim(), 'import "./b.strict";');
  }
});

test("strict conflicting imports are rejected but diamonds share export identities", () => {
  const source = 'import "./left.strict"; import "./right.strict"; main = value;';
  const conflict = compile(
    source,
    options({
      "file:///modules/left.strict": "value = 1;",
      "file:///modules/right.strict": "value = 2;",
    }),
  );
  assert.equal(conflict.success, false);
  assert.equal(
    evaluate(source, {
      "file:///modules/base.strict": "value = 42;",
      "file:///modules/left.strict": 'import "./base.strict"; left = value;',
      "file:///modules/right.strict": 'import "./base.strict"; right = value;',
    }),
    42,
  );
});

test("strict instance dictionaries and datatype identities survive diamond re-exports", () => {
  assert.equal(
    evaluate('import "./left.strict"; import "./right.strict"; main = choose 41;', {
      "file:///modules/base.strict":
        "class Select a where { select : a -> a; } instance Select number where { select x = x + 1; } choose x = select x;",
      "file:///modules/left.strict": 'import "./base.strict";',
      "file:///modules/right.strict": 'import "./base.strict";',
    }),
    42,
  );
});

test("strict imported modules evaluate once, while constructing effects stays inert", () => {
  const result = compile(
    'import "./left.strict"; import "./right.strict"; main = action;',
    options({
      "file:///modules/base.strict": "action = print 42;",
      "file:///modules/left.strict": 'import "./base.strict";',
      "file:///modules/right.strict": 'import "./base.strict";',
    }),
  );
  assert.ok(result.success, result.success ? "" : result.error.message);
  // The action is re-exported, never implicitly run by any import.
  const output: unknown[] = [];
  const context = {
    console: {
      log: (value: unknown) => {
        output.push(value);
      },
    },
  };
  assert.equal(
    typeof runInNewContext(result.value.javascript, context, { timeout: 1000 }),
    "function",
  );
  assert.equal(output.length, 0);
  runInNewContext(`(${result.value.javascript})({})`, context, { timeout: 1000 });
  assert.deepEqual(output, [42]);
});

test("strict imported hovers use root offsets and definitions use origin URIs", () => {
  const source = 'import "./helpers.strict";\nmain = identity 42;';
  const helper = "identity x = x;";
  const analysis = analyze(source, options({ "file:///modules/helpers.strict": helper }));
  assert.deepEqual(analysis.diagnostics, []);
  const offset = source.indexOf("identity");
  assert.equal(show(typeAt(analysis, offset)!.type), "(number -> number)");
  const definition = definitionAt(analysis, offset);
  assert.equal(definition?.uri, "file:///modules/helpers.strict");
  assert.deepEqual(definition?.span, { start: 0, end: 8 });
  assert.equal(analysis.sources?.get(definition!.uri!), helper);
  assert.equal(analysis.definitions.filter((value) => !value.uri).length, 1);
});

test("strict stdlib is an ordinary standalone module with local hover/definitions", () => {
  const uri = new URL("../examples/strict/stdlib.strict", import.meta.url).href;
  const source = readFileSync(new URL(uri), "utf8");
  const analysis = analyze(source, { uri });
  assert.deepEqual(analysis.diagnostics, []);
  const offset = source.indexOf("mapList f rest");
  assert.ok(typeAt(analysis, offset));
  assert.equal(definitionAt(analysis, offset)?.span.start, source.indexOf("mapList f list"));
  assert.ok(analysis.definitions.some((definition) => definition.name === "pure"));
  assert.ok(analysis.definitions.some((definition) => definition.name === "bind"));
});

test("strict caller-provided module reads model unsaved dependencies", () => {
  const source = 'import "./helpers.strict"; main = value + 1;';
  assert.deepEqual(
    analyze(source, options({ "file:///modules/helpers.strict": "value = 41;" })).diagnostics,
    [],
  );
  const changed = analyze(source, options({ "file:///modules/helpers.strict": "value = true;" }));
  assert.equal(changed.diagnostics.length, 1);
});

test("strict diagnostics retain transitive origin and root importer locations", () => {
  const source = '\nimport "./left.strict"; main = bad;';
  const base = "bad = missing;";
  const rootImport = parsedImportSpan(source, "file:///modules/left.strict", {
    "file:///modules/left.strict": 'import "./base.strict";',
    "file:///modules/base.strict": "base = 42;",
  });
  const result = compile(source, options({
    "file:///modules/left.strict": 'import "./base.strict";',
    "file:///modules/base.strict": base,
  }));
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.origin?.uri, "file:///modules/base.strict");
    assert.equal(result.error.location?.uri, "file:///modules/main.strict");
    assert.deepEqual(result.error.location?.span, rootImport);
    assert.equal(source.slice(rootImport.start, rootImport.end).trim(), 'import "./left.strict";');
    assert.ok(result.error.origin);
    assert.equal(base.slice(result.error.origin.span.start, result.error.origin.span.end), "missing");
    assert.ok(result.error.related?.some((entry) => entry.location.uri === "file:///modules/base.strict"));
  }
});

test("strict diagnostics choose the first root import path through a diamond", () => {
  const source = 'import "./left.strict"; import "./right.strict"; main = bad;';
  const leftImport = parsedImportSpan(source, "file:///modules/left.strict", {
    "file:///modules/left.strict": 'import "./base.strict";',
    "file:///modules/right.strict": 'import "./base.strict";',
    "file:///modules/base.strict": "base = 42;",
  });
  const result = compile(source, options({
    "file:///modules/left.strict": 'import "./base.strict";',
    "file:///modules/right.strict": 'import "./base.strict";',
    "file:///modules/base.strict": "bad = missing;",
  }));
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.origin?.uri, "file:///modules/base.strict");
    assert.deepEqual(result.error.location?.span, leftImport);
    assert.equal(source.slice(leftImport.start, leftImport.end).trim(), 'import "./left.strict";');
    assert.ok(result.error.related?.some((entry) => entry.location.uri === "file:///modules/base.strict"));
  }
});
