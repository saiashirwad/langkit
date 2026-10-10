import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadModules } from "../examples/modules.ts";
import { definitionAt, semanticTokens, type Analysis } from "langkit/analysis";

const root = "file:///workspace/main.strict";

const sources = (files: Record<string, string>) => (uri: string) => {
  const source = files[uri];
  if (source === undefined) throw new Error(`Missing: ${uri}`);
  return source;
};

test("module loader strips directives without changing offsets or newlines", () => {
  const source = '-- heading\r\nimport "./a.strict";\r\nimport "./b.strict";\nmain = 42;';
  const result = loadModules(
    source,
    {
      uri: root,
      read: sources({
        "file:///workspace/a.strict": "a = 1;",
        "file:///workspace/b.strict": "b = 2;",
      }),
    },
    "strict",
  );
  assert.ok(result.success);
  const module = result.value.modules.at(-1)!;
  assert.equal(module.source.length, source.length);
  assert.equal(module.original, source);
  assert.equal(module.source.indexOf("main"), source.indexOf("main"));
  assert.deepEqual(module.source.match(/\r\n|\n/g), source.match(/\r\n|\n/g));
  assert.equal(module.source.includes("import"), false);
  assert.equal(module.imports.length, 2);
  assert.equal(module.imports[0]!.span.start, source.indexOf("import"));
});

test("module loader uses topological once-only order for diamonds", () => {
  const counts = new Map<string, number>();
  const files = sources({
    "file:///workspace/a.strict": 'import "./shared.strict"; a = 1;',
    "file:///workspace/b.strict": 'import "./shared.strict"; b = 1;',
    "file:///workspace/shared.strict": "shared = 1;",
  });
  const result = loadModules(
    'import "./a.strict"; import "./b.strict"; main = 1;',
    {
      uri: root,
      read: (uri) => {
        counts.set(uri, (counts.get(uri) ?? 0) + 1);
        return files(uri);
      },
    },
    "strict",
  );
  assert.ok(result.success);
  assert.deepEqual(
    result.value.modules.map((module) => module.uri),
    [
      "file:///workspace/shared.strict",
      "file:///workspace/a.strict",
      "file:///workspace/b.strict",
      root,
    ],
  );
  assert.equal(counts.get("file:///workspace/shared.strict"), 1);
});

for (const [source, message] of [
  ['import "./a.rows"; main = 1;', /\.strict/],
  ['import "https://example.com/a.strict"; main = 1;', /Import paths/],
  ['import "/a.strict"; main = 1;', /Import paths/],
  ['import "./a.strict?query"; main = 1;', /query/],
  ['import "./a.strict#fragment"; main = 1;', /fragments/],
  ['import "./a.strict" main = 1;', /;/],
  ['import "bad\\q"; main = 1;', /Expected/],
  ['import "raw\tcontrol"; main = 1;', /Expected/],
] as const) {
  test(`module loader rejects ${JSON.stringify(source)}`, () => {
    const result = loadModules(source, { uri: root, read: () => "" }, "strict");
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, message);
  });
}

test("module loader reports cycles at the root import, retaining the dependency path", () => {
  const source = '\n\nimport "./a.strict"; main = 1;';
  const result = loadModules(
    source,
    {
      uri: root,
      read: sources({
        "file:///workspace/a.strict": "\n".repeat(50) + 'import "./main.strict"; a = 1;',
      }),
    },
    "strict",
  );
  assert.equal(result.success, false);
  if (!result.success) {
    assert.match(result.error.message, /Import cycle/);
    assert.equal(result.error.span?.start, source.indexOf("import"));
    assert.ok(result.error.context.includes("file:///workspace/a.strict"));
  }
});

test("module loader translates nested read and parse errors to the importing span", () => {
  for (const dependency of [
    "\n".repeat(30) + 'import "./missing.strict";',
    'import "unterminated',
  ]) {
    const source = 'import "./a.strict"; main = 42;';
    const result = loadModules(
      source,
      { uri: root, read: sources({ "file:///workspace/a.strict": dependency }) },
      "strict",
    );
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error.span?.start, 0);
      assert.ok(result.error.span!.end <= source.length);
    }
  }
});

test("module loader supports unsaved snapshots and literal spaces in filenames", () => {
  const result = loadModules(
    'import "./some file.strict"; main = value;',
    {
      uri: "file:///workspace/some%20directory/main.strict",
      read: (uri) => {
        assert.equal(uri, "file:///workspace/some%20directory/some%20file.strict");
        return "value = 42;";
      },
    },
    "strict",
  );
  assert.ok(result.success);
  assert.equal(result.value.modules[0]!.source, "value = 42;");
});

test("module loader defaults to local filesystem and never reads the supplied root", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "langkit-modules-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "child.strict"), "child = 42;");
  const uri = pathToFileURL(join(directory, "root.strict")).href;
  const result = loadModules('import "./child.strict"; main = child;', { uri }, "strict");
  assert.ok(result.success);
  assert.equal(result.value.root, uri);
  assert.equal(result.value.modules[0]!.original, "child = 42;");
  assert.ok(loadModules("main = 42;", {}, "strict").success);
  assert.equal(
    loadModules("main = 42;", { uri: "https://example.com/root.strict" }, "strict").success,
    false,
  );
});

test("external definitions resolve references without claiming local declaration offsets", () => {
  const id = Symbol("external");
  const analysis: Analysis<string> = {
    diagnostics: [],
    types: [],
    definitions: [
      {
        id,
        name: "external",
        type: "number",
        kind: "function",
        uri: "file:///dep.strict",
        span: { start: 0, end: 5 },
      },
    ],
    references: [{ id, span: { start: 10, end: 15 } }],
    tokens: [
      { kind: "variable", span: { start: 0, end: 5 } },
      { kind: "variable", span: { start: 10, end: 15 } },
    ],
  };
  assert.equal(definitionAt(analysis, 0), undefined);
  assert.equal(definitionAt(analysis, 10)?.uri, "file:///dep.strict");
  assert.deepEqual(
    semanticTokens(analysis).map((token) => token.kind),
    ["variable", "function"],
  );
});

test("module loader leaves body strings and identifier prefixes intact", () => {
  for (const source of ["important = 42;", 'main = "import \\"./x.strict\\";";']) {
    const result = loadModules(source, { uri: root }, "strict");
    assert.ok(result.success);
    assert.equal(result.value.modules[0]!.source, source);
  }
});
