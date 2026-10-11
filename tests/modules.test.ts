import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadModules } from "langkit/modules";
import { definitionAt, semanticTokens, type Analysis } from "langkit/analysis";

const root = "file:///workspace/main.strict";

const sources = (files: Record<string, string>) => (uri: string) => {
  const source = files[uri];
  if (source === undefined) throw new Error(`Missing: ${uri}`);
  return source;
};

const parsedImportSpan = (source: string, target: string, files: Record<string, string>) => {
  const graph = loadModules(source, { uri: root, read: sources(files) }, "strict");
  assert.ok(graph.success);
  const edge = graph.value.module(root)?.imports.find((dependency) => dependency.uri === target);
  assert.ok(edge);
  return edge.span;
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

for (const source of [
  'import "./a.rows"; main = 1;',
  'import "https://example.com/a.strict"; main = 1;',
  'import "/a.strict"; main = 1;',
  'import "./a.strict?query"; main = 1;',
  'import "./a.strict#fragment"; main = 1;',
  'import "./a.strict" main = 1;',
  'import "bad\\q"; main = 1;',
  'import "raw\tcontrol"; main = 1;',
] as const) {
  test("module loader rejects " + JSON.stringify(source), () => {
    const result = loadModules(source, { uri: root, read: () => "" }, "strict");
    assert.equal(result.success, false);
  });
}

test("module loader locates a cycle at the root import and preserves origin", () => {
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
    assert.equal(result.error.span?.start, source.indexOf("import"));
    assert.equal(result.error.origin?.uri, "file:///workspace/a.strict");
    assert.equal(result.error.location?.uri, root);
  }
});

test("module loader routes transitive failures to the root import while preserving origin", () => {
  const source = '\nimport "./a.strict"; main = 42;';
  const child = '\n'.repeat(30) + 'import "./missing.strict";';
  const rootImport = parsedImportSpan(source, "file:///workspace/a.strict", {
    "file:///workspace/a.strict": "a = 42;",
  });
  const result = loadModules(source, {
    uri: root,
    read: sources({
      "file:///workspace/a.strict": 'import "./child.strict";',
      "file:///workspace/child.strict": child,
    }),
  }, "strict");
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.origin?.uri, "file:///workspace/child.strict");
    assert.ok(result.error.origin);
    assert.equal(child.slice(result.error.origin.span.start, result.error.origin.span.end).trim(), 'import "./missing.strict";');
    assert.equal(result.error.location?.uri, root);
    assert.deepEqual(result.error.location?.span, rootImport);
    assert.equal(source.slice(rootImport.start, rootImport.end).trim(), 'import "./a.strict";');
    assert.ok(result.error.related?.some((entry) => entry.location.uri === "file:///workspace/child.strict"));
  }
});

test("module loader chooses a deterministic importer through a diamond and preserves snapshots", () => {
  const source = 'import "./left.strict"; import "./right.strict"; main = 42;';
  const shared = 'import "./missing.strict";';
  const read = sources({
    "file:///workspace/left.strict": 'import "./shared.strict";',
    "file:///workspace/right.strict": 'import "./shared.strict";',
    "file:///workspace/shared.strict": shared,
  });
  const leftImport = parsedImportSpan(source, "file:///workspace/left.strict", {
    "file:///workspace/left.strict": 'import "./shared.strict";',
    "file:///workspace/right.strict": 'import "./shared.strict";',
    "file:///workspace/shared.strict": "shared = 1;",
  });
  const failed = loadModules(source, { uri: root, read }, "strict");
  assert.equal(failed.success, false);
  if (!failed.success) {
    assert.equal(failed.error.origin?.uri, "file:///workspace/shared.strict");
    assert.ok(failed.error.origin);
    assert.equal(shared.slice(failed.error.origin.span.start, failed.error.origin.span.end).trim(), 'import "./missing.strict";');
    assert.deepEqual(failed.error.location?.span, leftImport);
    assert.equal(failed.error.location?.uri, root);
    assert.equal(source.slice(leftImport.start, leftImport.end).trim(), 'import "./left.strict";');
    assert.ok(failed.error.related?.some((entry) => entry.location.uri === "file:///workspace/shared.strict"));
  }

  const loaded = loadModules(source, {
    uri: "file:///workspace/./main.strict",
    read: sources({
      "file:///workspace/left.strict": 'import "./shared.strict";',
      "file:///workspace/right.strict": 'import "./shared.strict";',
      "file:///workspace/shared.strict": "shared = 1;",
    }),
  }, "strict");
  assert.ok(loaded.success);
  assert.equal(loaded.value.root, root);
  assert.equal(loaded.value.module("file:///workspace/shared.strict")?.original, "shared = 1;");
  assert.equal(loaded.value.sources.get("file:///workspace/shared.strict"), "shared = 1;");
});

test("module loader locates an invalid import after importing a malformed child", () => {
  const source = 'import "./broken.strict";';
  const broken = '\n\nimport "unterminated';
  const result = loadModules(source, { uri: root, read: sources({ "file:///workspace/broken.strict": broken }) }, "strict");
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.origin?.uri, "file:///workspace/broken.strict");
    assert.equal(result.error.location?.uri, root);
    assert.deepEqual(result.error.location?.span, { start: 0, end: source.length });
    assert.ok(result.error.origin!.span.start > 0);
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
