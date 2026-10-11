import assert from "node:assert/strict";
import { test } from "node:test";
import { defineSyntax, syntax } from "../src/syntax.ts";
import type { NodeOf, SyntaxDeclarations } from "../src/syntax.ts";

function language() {
  return defineSyntax({
    number: syntax.node("number", { value: syntax.data<number>() }),
    variable: syntax.node("variable", { name: syntax.data<string>() }),
    fn: syntax.node("fn", { param: syntax.binder(), body: syntax.scopedChild({ binds: ["param"] }) }),
    let: syntax.node("let", {
      name: syntax.binder(),
      value: syntax.child(),
      body: syntax.scopedChild({ binds: ["name"] }),
    }),
    rec: syntax.node("rec", {
      name: syntax.binder(),
      value: syntax.scopedChild({ binds: ["name"] }),
      body: syntax.scopedChild({ binds: ["name"] }),
    }),
    pair: syntax.node("pair", { left: syntax.child(), right: syntax.child() }),
    record: syntax.node("record", { fields: syntax.entries(), note: syntax.optionalData<{ tags: string[]; }>() }),
    call: syntax.node("call", { fn: syntax.child(), args: syntax.children() }),
  });
}

test("one declaration builds recursive function, let, record and pair syntax", () => {
  const schema = language();
  const { make } = schema;
  const id = syntax.binding("id");
  const x = syntax.binding("x");
  const number = make.number({ value: 1 });
  const fn = make.fn({ param: x, body: make.variable({ name: "x" }) });
  const call = make.call({ fn: make.variable({ name: "id" }), args: [number] });
  const record = make.record({ fields: [{ label: "answer", child: call }] });
  const root = make.let({ name: id, value: fn, body: make.pair({ left: record, right: number }) });
  const visits: [string, string[]][] = [];
  schema.walkScoped(root, (node, { scope }) => visits.push([node.kind, scope.map(binder => binder.name)]));
  assert.deepEqual(visits, [
    ["let", []],
    ["fn", []],
    ["variable", ["x"]],
    ["pair", ["id"]],
    ["record", ["id"]],
    ["call", ["id"]],
    ["variable", ["id"]],
    ["number", ["id"]],
    ["number", ["id"]],
  ]);
  assert.notEqual(number.id, make.number({ value: 1 }).id);
  assert(Object.isFrozen(root));
  assert(Object.isFrozen(schema));
  assert(Object.isFrozen(schema.make));
});

test("recursive visibility is explicit and scopes do not leak to siblings", () => {
  const schema = language();
  const name = syntax.binding("f");
  const param = syntax.binding("x");
  const fn = schema.make.fn({ param, body: schema.make.variable({ name: "f" }) });
  const body = schema.make.variable({ name: "f" });
  const root = schema.make.rec({ name, value: fn, body });
  const scopes: string[][] = [];
  schema.walkScoped(root, (_, context) => {
    assert(Object.isFrozen(context));
    assert(Object.isFrozen(context.scope));
    scopes.push(context.scope.map(binder => binder.name));
  });
  assert.deepEqual(scopes, [[], ["f"], ["f", "x"], ["f"]]);
});

test("children preserve field declaration, list, and labelled entry order", () => {
  const schema = language();
  const first = schema.make.number({ value: 1 });
  const second = schema.make.number({ value: 2 });
  const pair = schema.make.pair({ right: second, left: first });
  assert.deepEqual(schema.children(pair).map(edge => [edge.field, edge.child]), [["left", first], ["right", second]]);
  const record = schema.make.record({ fields: [{ label: "b", child: second }, { label: "a", child: first }] });
  assert.deepEqual(schema.children(record).map(edge => [edge.label, edge.index]), [["b", 0], ["a", 1]]);
  const call = schema.make.call({ fn: first, args: [second, pair] });
  const visited: string[] = [];
  schema.visitChildren(call, (_, edge) => visited.push(`${edge.field}:${edge.index ?? "single"}`));
  assert.deepEqual(visited, ["fn:single", "args:0", "args:1"]);
  assert(Object.isFrozen(schema.children(record)));
  assert(schema.children(record).every(Object.isFrozen));
});

test("immutable mapping preserves kind, identity, spans, labels, binders and source trees", () => {
  const schema = language();
  const first = schema.make.number({ value: 1 });
  const replacement = schema.make.number({ value: 2 });
  const span = { start: 10, end: 20 };
  const name = syntax.binding("x");
  const fn = schema.make.fn({ param: name, body: first }, { span });
  span.start = 0;
  const mapped = schema.map(fn, () => replacement);
  assert.equal(mapped.kind, "fn");
  assert.equal(mapped.id, fn.id);
  assert.deepEqual(mapped.span, { start: 10, end: 20 });
  assert.equal(mapped.param, name);
  assert.equal(mapped.body, replacement);
  assert.equal(fn.body, first);
  assert.equal(schema.map(fn, node => node), fn);
  const record = schema.make.record({
    fields: [{ label: "x", child: first }, { label: "x", child: first }],
    note: { tags: ["same"] },
  });
  const mappedRecord = schema.map(record, () => replacement);
  assert.deepEqual(mappedRecord.fields.map(entry => entry.label), ["x", "x"]);
  assert(mappedRecord.fields.every(entry => entry.child === replacement));
  assert.equal(mappedRecord.note, record.note);
  assert.equal(mapped.span, fn.span);
  const call = schema.make.call({ fn: first, args: [first, first] });
  assert(schema.map(call, () => replacement).args.every(node => node === replacement));
  type Node = NodeOf<typeof schema>;
  function increment(node: Node): Node {
    if (node.kind === "number") return schema.make.number({ value: node.value + 1 });
    return schema.map(node, increment);
  }
  assert.equal((increment(fn) as typeof fn).body.kind, "number");
});

test("construction snapshots data, child arrays, entries and schema configuration", () => {
  const schema = language();
  const leaf = schema.make.number({ value: 1 });
  const entries = [{ label: "x", child: leaf }];
  const note = { tags: ["a"] };
  const record = schema.make.record({ fields: entries, note });
  entries[0]!.label = "y";
  entries.length = 0;
  note.tags.push("b");
  assert.deepEqual(record.fields, [{ label: "x", child: leaf }]);
  assert.deepEqual(record.note, { tags: ["a"] });
  assert(Object.isFrozen(record.note!.tags));
  const binds: "name"[] = ["name"];
  const fields = { name: syntax.binder(), body: syntax.scopedChild({ binds }) };
  const declaration = syntax.node("fn", fields);
  binds.length = 0;
  fields.body = syntax.scopedChild({ binds: [] });
  const declarations = { fn: declaration, number: syntax.node("number", { value: syntax.data<number>() }) };
  const saved = defineSyntax(declarations);
  declarations.fn = syntax.node("fn", fields);
  const name = syntax.binding("x");
  const fn = saved.make.fn({ name, body: saved.make.number({ value: 1 }) });
  assert.deepEqual(saved.children(fn)[0]!.binders, [name]);
});

test("runtime boundaries reject foreign nodes in construction, mapping and traversal", () => {
  const schema = language();
  const other = language();
  const leaf = schema.make.number({ value: 1 });
  const foreign = other.make.number({ value: 2 });
  assert.throws(() => schema.make.pair({ left: leaf, right: foreign }), /belong/);
  assert.throws(() => schema.make.record({ fields: [{ label: "x", child: foreign }] }), /belong/);
  assert.throws(() => schema.make.call({ fn: leaf, args: [foreign] }), /belong/);
  assert.throws(() => schema.make.call({ fn: leaf, args: Array(1) }), /belong/);
  assert.throws(() => schema.children(foreign), /belong/);
  assert.throws(() => schema.walkScoped(foreign, () => {}), /belong/);
  const fn = schema.make.fn({ param: syntax.binding("x"), body: leaf });
  assert.throws(() => schema.map(fn, () => foreign), /belong/);
  assert.throws(() => schema.children({ ...leaf }), /belong/);
});

test("dynamic configuration validates kinds, descriptors, binds and reserved fields", () => {
  const dynamic = defineSyntax as (declarations: SyntaxDeclarations) => unknown;
  assert.throws(() => dynamic({ a: { kind: "a", fields: {} }, b: { kind: "a", fields: {} } }), /Duplicate/);
  assert.throws(() => dynamic({ a: { kind: "b", fields: {} } }), /match/);
  assert.throws(
    () =>
      dynamic({
        a: { kind: "a", fields: { value: syntax.data<number>(), body: syntax.scopedChild({ binds: ["value"] }) } },
      }),
    /non-binder/,
  );
  assert.throws(
    () => dynamic({ a: { kind: "a", fields: { body: syntax.scopedChild({ binds: ["missing"] }) } } }),
    /non-binder/,
  );
  assert.throws(
    () =>
      dynamic({
        a: { kind: "a", fields: { name: syntax.binder(), body: syntax.scopedChild({ binds: ["name", "name"] }) } },
      }),
    /Invalid binds/,
  );
  assert.throws(() => dynamic({ a: { kind: "a", fields: { id: syntax.data<number>() } } }), /Reserved/);
  assert.throws(
    () => dynamic(JSON.parse("{\"a\":{\"kind\":\"a\",\"fields\":{\"body\":{\"tag\":\"unknown\"}}}}")),
    /Invalid syntax field/,
  );
  assert.throws(
    () => dynamic(JSON.parse("{\"a\":{\"kind\":\"a\",\"fields\":{\"body\":{\"tag\":\"child\"}}}}")),
    /Invalid binds/,
  );
  assert.throws(() => dynamic(JSON.parse("[]")), /declaration record/);
  assert.throws(() => dynamic({ [Symbol("kind")]: syntax.node("a", {}) }), /string keys/);
  assert.throws(
    () => dynamic({ a: { kind: "a", fields: { [Symbol("field")]: syntax.data<number>() } } }),
    /string keys/,
  );
});

test("dynamic construction checks structure, not erased scalar typing semantics", () => {
  const schema = language();
  const makeNumber = schema.make.number as (fields: unknown) => unknown;
  assert.throws(() => makeNumber({}), /Missing/);
  assert.throws(() => makeNumber({ value: 1, extra: 2 }), /Unknown/);
  assert.doesNotThrow(() => makeNumber({ value: "scalar types are checked by TypeScript" }));
  const leaf = schema.make.number({ value: 1 });
  const makeFn = schema.make.fn as (fields: unknown) => unknown;
  assert.throws(() => makeFn({ param: "x", body: leaf }), /Invalid binder/);
  assert.throws(() => makeFn({ param: Object.freeze({ ...syntax.binding("fake") }), body: leaf }), /Invalid binder/);
  const data = defineSyntax({ data: syntax.node("data", { value: syntax.data<unknown>() }) });
  assert.throws(() => data.make.data({ value: new Map() }), /plain immutable/);
  assert.throws(() => data.make.data({ value: () => 1 }), /plain immutable/);
  const cyclic: { self?: unknown; } = {};
  cyclic.self = cyclic;
  assert.throws(() => data.make.data({ value: cyclic }), /Cyclic/);
});

test("prototype-like field names are ordinary declared data", () => {
  const schema = defineSyntax({
    object: syntax.node("object", {
      ["__proto__"]: syntax.data<number>(),
      constructor: syntax.data<string>(),
      toString: syntax.child(),
    }),
    leaf: syntax.node("leaf", {}),
  });
  const leaf = schema.make.leaf({});
  const node = schema.make.object({ ["__proto__"]: 42, constructor: "name", toString: leaf });
  assert.equal(node.__proto__, 42);
  assert.equal(node.constructor, "name");
  assert.equal(schema.children(node)[0]!.child, leaf);
  assert.equal(schema.map(node, () => schema.make.leaf({})).__proto__, 42);
});

test("scoped lists and labelled entries inherit only annotated binders", () => {
  const schema = defineSyntax({
    group: syntax.node("group", {
      name: syntax.binder(),
      unscoped: syntax.child(),
      children: syntax.scopedChildren({ binds: ["name"] }),
      entries: syntax.scopedEntries({ binds: ["name"] }),
    }),
    leaf: syntax.node("leaf", {}),
  });
  const leaf = schema.make.leaf({});
  const root = schema.make.group({
    name: syntax.binding("g"),
    unscoped: leaf,
    children: [leaf],
    entries: [{ label: "x", child: leaf }],
  });
  const scopes: string[][] = [];
  schema.walkScoped(root, (_, { scope }) => scopes.push(scope.map(binder => binder.name)));
  assert.deepEqual(scopes, [[], [], ["g"], ["g"]]);
});

test("structural walking handles deeply nested trees without recursive calls", () => {
  const schema = defineSyntax({ chain: syntax.node("chain", { next: syntax.child() }), leaf: syntax.node("leaf", {}) });
  let root: NodeOf<typeof schema> = schema.make.leaf({});
  for (let i = 0; i < 20_000; i++) root = schema.make.chain({ next: root });
  let visited = 0;
  schema.walkScoped(root, () => visited++);
  assert.equal(visited, 20_001);
});
