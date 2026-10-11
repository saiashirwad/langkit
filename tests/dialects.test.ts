import { test } from "node:test";
import assert from "node:assert/strict";
import { create } from "../src/ir.ts";
import { defineOperation, traversalOf } from "../src/operations/descriptor.ts";
import { composeDialects, defineBackend, defineDialect } from "../src/operations/dialect.ts";
import { records } from "../src/operations/records.ts";
import { variants } from "../src/operations/variants.ts";
import { folders } from "../src/operations/folders.ts";
import { coreJavaScript } from "../src/javascript/core.ts";
import { recordsJavaScript } from "../src/javascript/records.ts";
import { defineJavaScriptBackend, createJavaScriptDispatcher } from "../src/javascript/operations.ts";
import { corePython } from "../src/python/core.ts";
import { recordsPython } from "../src/python/records.ts";
import { definePythonBackend, createPythonDispatcher } from "../src/python/operations.ts";
import { emit as emitJavaScript } from "../src/javascript.ts";
import { emit as emitPython } from "../src/python.ts";

const custom = () => defineOperation<string, { kind: "shared"; count: number }>("shared", {
  children: () => [], scopedBodies: () => [], references: () => [], map: (node) => node,
});

test("backend tables require own callable handlers even for prototype names", () => {
  const context = { depth: 0, expr: () => "", block: () => "", name: () => "" };
  for (const key of ["toString", "constructor", "valueOf", "0"]) {
    const operation = custom();
    const dialect = defineDialect({ [key]: operation });
    type Table = { [key: string]: (node: { kind: "shared"; count: number }) => string };
    for (const backend of [
      (table: Table) => defineJavaScriptBackend(dialect, table),
      (table: Table) => definePythonBackend(dialect, table),
      (table: Table) => defineBackend<typeof context>()(dialect, table),
    ]) {
      assert.throws(() => backend({}), /Missing backend handler/);
      assert.throws(() => backend(Object.create({ [key]: () => "inherited" })), /Missing backend handler/);
      const invalid: Table = {};
      Object.defineProperty(invalid, key, { value: null });
      assert.throws(() => backend(invalid), /Missing backend handler/);
      const table = { [key]: (node: { kind: "shared"; count: number }) => String(node.count) };
      const handlers = backend(table);
      table[key] = () => "replacement";
      assert.equal(createJavaScriptDispatcher(...handlers)(operation.id, operation.make("number", { kind: "shared", count: 42 }).node, context), "42");
    }
  }
});

test("dialects reject symbol and nonenumerable descriptor keys", () => {
  assert.throws(() => defineDialect({ [Symbol("hidden")]: custom() }), /enumerable string/);
  assert.throws(() => defineDialect(Object.defineProperty({}, "hidden", { value: custom() })), /enumerable string/);
});

test("dialects preserve actual descriptors and reject duplicate identities and keys", () => {
  const first = custom();
  const second = custom();
  const left = defineDialect({ first });
  const right = defineDialect({ second });
  const combined = composeDialects(left, right);
  assert.equal(combined.descriptors.first, first);
  assert.equal(combined.descriptors.second, second);
  assert.equal(combined.operations.length, 2);
  assert.throws(() => defineDialect({ first, duplicate: first }), /Duplicate operation descriptor/);
  assert.throws(() => composeDialects(left, defineDialect({ first: second })), /Duplicate dialect key/);
  assert.throws(() => composeDialects(left, defineDialect({ alias: first })), /Duplicate operation descriptor/);
});

test("backend tables dispatch by identity even when kinds collide and keys differ", () => {
  const first = custom();
  const second = custom();
  const dialect = defineDialect({ one: first, two: second });
  const js = defineJavaScriptBackend(dialect, { one: (node) => `first:${node.count}`, two: (node) => `second:${node.count}` });
  const py = definePythonBackend(dialect, { one: (node) => `first:${node.count}`, two: (node) => `second:${node.count}` });
  const jsDispatch = createJavaScriptDispatcher(...js);
  const pyDispatch = createPythonDispatcher(...py);
  const context = { depth: 0, expr: () => "", block: () => "", name: () => "" };
  assert.equal(jsDispatch(first.id, { kind: "shared", count: 1 } as ReturnType<typeof first.make>["node"], context), "first:1");
  assert.equal(pyDispatch(second.id, { kind: "shared", count: 2 } as ReturnType<typeof second.make>["node"], context), "second:2");
  assert.throws(() => jsDispatch(custom().id, { kind: "shared" }, context), /Missing JavaScript handler/);
  assert.throws(() => pyDispatch(custom().id, { kind: "shared" }, context), /Missing Python handler/);
  assert.throws(() => createJavaScriptDispatcher(...js, ...js), /Duplicate JavaScript handler/);
});

test("builtin backend tables use builder and feature descriptor instances", () => {
  const feature = records<string>();
  const builder = create<string>().use(feature);
  assert.equal(builder.descriptors.record, feature.descriptors.record);
  assert.equal(builder.descriptors.literal, builder.coreDescriptors.literal);
  const value = builder.field("number", builder.record("record", [{ name: "x", value: builder.literal("number", 42) }]), "x");
  const program = builder.program(builder.body({ declarations: [], result: value }));
  assert.equal(Function(`return ${emitJavaScript(program, [...coreJavaScript(builder.coreDescriptors), ...recordsJavaScript(feature.descriptors)])}`)(), 42);
  assert.match(emitPython(program, [...corePython(builder.coreDescriptors), ...recordsPython(feature.descriptors)]), /42\.0/);
  assert.throws(() => emitJavaScript(program, coreJavaScript(create<string>().coreDescriptors)), /Missing JavaScript handler/);
});

test("programs snapshot registries before later feature installation", () => {
  const builder = create<string>();
  const program = builder.program({ declarations: [], result: builder.literal("number", 1) });
  const dialect = builder.dialect();
  const count = program.operations.length;
  builder.use(records<string>());
  assert.equal(program.operations.length, count);
  assert.equal(dialect.operations.length, count);
  assert.equal(Object.hasOwn(dialect.descriptors, "record"), false);
  assert.equal(builder.operationTraversals().length, count + 3);
});

test("selected descriptors reject alias mutation after dialect publication", () => {
  const descriptor = { ...custom() };
  const dialect = defineDialect({ custom: descriptor });
  const builder = create<string>().use({ ...dialect, methods: {} });
  const value = descriptor.make("number", { kind: "shared", count: 42 });
  const program = builder.program({ declarations: [], result: value });
  assert.throws(() => { descriptor.id = Symbol("replacement"); }, TypeError);
  assert.throws(() => { descriptor.children = () => [builder.literal("number", 0)]; }, TypeError);
  assert.throws(() => { descriptor.references = () => [builder.binding("escaped", "number")]; }, TypeError);
  assert.equal(program.operations.at(-1)!.id, value.operationId);
  const handlers = defineJavaScriptBackend(dialect, { custom: node => String(node.count) });
  assert.equal(Function(`return ${emitJavaScript(program, handlers)}`)(), 42);
});

test("standalone traversals capture callbacks and publish immutable entries", () => {
  const descriptor = { ...custom() };
  const selected = traversalOf(descriptor);
  descriptor.children = () => [{ type: "number", operationId: Symbol(), node: { kind: "unknown" } }];
  descriptor.references = () => [{ id: Symbol(), name: "escaped", type: "number" }];
  assert.deepEqual(selected.children({ kind: "shared" }), []);
  assert.deepEqual(selected.references({ kind: "shared" }), []);
  assert.equal(Reflect.set(selected, "id", Symbol("replacement")), false);
});

test("named feature records derive registry order and reject composition collisions", () => {
  const recordFeature = records<string>();
  const variantFeature = variants<string>();
  const folderFeature = folders<string>();
  for (const feature of [recordFeature, variantFeature, folderFeature]) {
    assert.deepEqual(feature.operations.map((operation) => operation.id), Object.values(feature.descriptors).map((descriptor) => descriptor.id));
  }
  const builder = create<string>().use(recordFeature);
  assert.throws(() => builder.use(records<string>()), /Duplicate language feature method|Duplicate dialect key/);
  assert.throws(() => builder.use({ descriptors: { literal: custom() }, operations: [], methods: {} }), /Duplicate dialect key/);
  assert.throws(() => builder.use({ descriptors: { alias: recordFeature.descriptors.record }, operations: [], methods: {} }), /Duplicate language operation descriptor/);
});
