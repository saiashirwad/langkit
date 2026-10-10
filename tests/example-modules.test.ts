import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { definitionAt, typeAt } from "langkit/analysis";
import { validate } from "langkit/ir";
import * as rows from "../examples/rows/rows.ts";
import * as advanced from "../examples/advanced/advanced.ts";

for (const [extension, language] of [
  ["rows", rows],
  ["advanced", advanced],
] as const) {
  const uri = `file:///modules/main.${extension}`;

  const options = (files: Record<string, string>) => ({
    uri,
    read: (path: string) => {
      const source = files[path];
      if (source === undefined) throw new Error(`Missing fixture: ${path}`);
      return source;
    },
  });

  const evaluate = (
    source: string,
    files: Record<string, string>,
    log: (value: unknown) => void = () => {},
  ) => {
    const result = language.compile(source, options(files));
    assert.ok(result.success, result.success ? "" : result.error.message);
    validate<unknown>(result.value.ir);
    return runInNewContext(result.value.javascript, { console: { log } }, { timeout: 1000 });
  };

  test(`${extension} requires manual imports and still provides print`, () => {
    assert.equal(language.compile("id(42)").success, false);
    assert.equal(language.compile("let id = fn(x) => x in id(42)").success, true);
    assert.equal(language.compile("print(42)").success, true);
    if (extension === "advanced") assert.equal(language.compile("Some(42)").success, false);
  });

  test(`${extension} stdlib is a normal standalone editor document`, () => {
    const file = new URL(`../examples/${extension}/stdlib.${extension}`, import.meta.url);
    const source = readFileSync(file, "utf8");
    const analysis = language.analyze(source, { uri: file.href });
    assert.deepEqual(analysis.diagnostics, []);
    assert.ok(analysis.types.length > 0);
    assert.ok(analysis.definitions.length > 0);
    assert.ok(analysis.definitions.every((definition) => definition.uri === undefined));
    const result = language.compile(`import "./stdlib.${extension}"; id(42)`, {
      uri: new URL(`../examples/${extension}/main.${extension}`, import.meta.url).href,
      read: (uri) => readFileSync(new URL(uri), "utf8"),
    });
    assert.ok(result.success, result.success ? "" : result.error.message);
    assert.equal(runInNewContext(result.value.javascript, {}, { timeout: 1000 }), 42);
  });

  test(`${extension} imports are polymorphic and retain external definition offsets`, () => {
    const libraryUri = `file:///modules/helpers.${extension}`;
    const library = "let id = fn(x) => x in { id = id }";
    const source = `import "./helpers.${extension}";\nif id(true) then id(42) else 0`;
    const files = { [libraryUri]: library };
    assert.equal(evaluate(source, files), 42);
    const analysis = language.analyze(source, options(files));
    assert.deepEqual(analysis.diagnostics, []);
    assert.equal(analysis.tokens.find((token) => token.span.start === 0)?.kind, "keyword");
    const use = source.lastIndexOf("id");
    const definition = definitionAt<unknown>(analysis, use);
    assert.equal(definition?.uri, libraryUri);
    assert.deepEqual(definition?.span, { start: 4, end: 6 });
    assert.equal(analysis.sources?.get(libraryUri), library);
    assert.ok(typeAt<unknown>(analysis, use));
    assert.ok(analysis.types.every((fact) => fact.span.start >= source.indexOf("if")));
  });

  test(`${extension} imported aliases navigate to the exported label, not its initializer`, () => {
    const aliasUri = `file:///modules/alias.${extension}`;
    const alias = `import "./base.${extension}"; { x = xyz }`;
    const source = `import "./alias.${extension}"; x`;
    const analysis = language.analyze(
      source,
      options({
        [`file:///modules/base.${extension}`]: "{ xyz = 42 }",
        [aliasUri]: alias,
      }),
    );
    assert.deepEqual(analysis.diagnostics, []);
    const definition = definitionAt<unknown>(analysis, source.lastIndexOf("x"));
    assert.equal(definition?.uri, aliasUri);
    const start = alias.indexOf("x =");
    assert.deepEqual(definition?.span, { start, end: start + 1 });
  });

  test(`${extension} diamond imports share exports and initialize a module once`, () => {
    const base = `file:///modules/base.${extension}`;
    const left = `file:///modules/left.${extension}`;
    const right = `file:///modules/right.${extension}`;
    const files = {
      [base]: "let ignored = print(1) in { answer = 42 }",
      [left]: `import "./base.${extension}"; { left = answer }`,
      [right]: `import "./base.${extension}"; { right = answer }`,
    };
    const output: unknown[] = [];
    assert.equal(
      evaluate(
        `import "./left.${extension}"; import "./right.${extension}"; answer`,
        files,
        (value) => output.push(value),
      ),
      42,
    );
    assert.deepEqual(output, [1]);
  });

  test(`${extension} rejects conflicting imports and isolates unrelated dependencies`, () => {
    const files = {
      [`file:///modules/a.${extension}`]: "{ x = 1 }",
      [`file:///modules/b.${extension}`]: "{ x = 2 }",
    };
    const conflict = language.compile(
      `import "./a.${extension}"; import "./b.${extension}"; x`,
      options(files),
    );
    assert.equal(conflict.success, false);
    if (!conflict.success) assert.match(conflict.error.message, /Conflicting imported name/);
    const isolated = language.compile(
      `import "./a.${extension}"; import "./b.${extension}"; x`,
      options({ ...files, [`file:///modules/b.${extension}`]: "{ y = x }" }),
    );
    assert.equal(isolated.success, false);
    if (!isolated.success) assert.match(isolated.error.message, /Unbound variable/);
  });

  test(`${extension} reports dependency errors at the current import and uses fresh snapshots`, () => {
    const dependency = `file:///modules/value.${extension}`;
    const source = `import "./value.${extension}"; answer`;
    let text = "{ answer = 42 }";
    const context = { uri, read: () => text };
    assert.deepEqual(language.analyze(source, context).diagnostics, []);
    text = "let ignored = 1 in { answer = missing }";
    const analysis = language.analyze(source, context);
    assert.equal(analysis.diagnostics.length, 1);
    assert.match(analysis.diagnostics[0]!.message, /Unbound variable/);
    assert.equal(analysis.diagnostics[0]!.span?.start, 0);
    assert.ok(analysis.diagnostics[0]!.context.includes(dependency));
    text = "{ answer = true }";
    assert.deepEqual(language.analyze(source, context).diagnostics, []);
  });

  test(`${extension} rejects non-record imported modules`, () => {
    const result = language.compile(
      `import "./value.${extension}"; 42`,
      options({
        [`file:///modules/value.${extension}`]: "42",
      }),
    );
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, /must return a record/);
  });
}

test("advanced constructor exports cannot overwrite an imported ordinary value", () => {
  const files: Record<string, string> = {
    "file:///modules/value.advanced": "{ Box = 42 }",
    "file:///modules/constructor.advanced": 'import "./value.advanced"; type T = Box {}',
  };
  const result = advanced.compile('import "./constructor.advanced"; Box', {
    uri: "file:///modules/main.advanced",
    read: (uri) => files[uri]!,
  });
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error.message, /Conflicting exported name: Box/);
});

test("advanced imports nominal datatype constructors and definitions", () => {
  const source = 'import "./box.advanced"; match Box(42) { Box(x) => unbox(Box(x)) }';
  const dependency =
    "type Box(a) = Box(a) let unbox = fn(box) => match box { Box(x) => x } in { unbox = unbox }";
  const options = { uri: "file:///modules/main.advanced", read: () => dependency };
  const result = advanced.compile(source, options);
  assert.ok(result.success, result.success ? "" : result.error.message);
  validate(result.value.ir);
  assert.equal(runInNewContext(result.value.javascript, {}, { timeout: 1000 }), 42);
  const analysis = advanced.analyze(source, options);
  assert.deepEqual(analysis.diagnostics, []);
  const declaration = definitionAt(analysis, source.indexOf("Box(42)"));
  assert.equal(declaration?.uri, "file:///modules/box.advanced");
  assert.equal(declaration?.span.start, dependency.indexOf("Box(a)", dependency.indexOf("=") + 1));
});
