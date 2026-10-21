import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "../src/ir.ts";
import { createJavaScriptEmitter, defineJavaScriptBackend } from "../src/javascript.ts";
import { coreJavaScript } from "../src/javascript/core.ts";
import { recordsJavaScript } from "../src/javascript/records.ts";
import { defineOperation } from "../src/operations/descriptor.ts";
import { records } from "../src/operations/records.ts";

const custom = () => defineOperation<string, { kind: "shared"; count: number; }>("shared");

test("backend tables dispatch by identity even when kinds collide and keys differ", () => {
  const first = custom();
  const second = custom();
  const handlers = defineJavaScriptBackend({ one: first, two: second }, {
    one: (node) => `first:${node.count}`,
    two: (node) => `second:${node.count}`,
  });
  const builder = create<string>().use({ methods: {}, descriptors: { one: first, two: second } });
  const program = (value: ReturnType<typeof first.make>) => builder.program({ declarations: [], result: value });
  const emitter = createJavaScriptEmitter(handlers);
  assert.equal(
    emitter.emit(program(first.make("number", { kind: "shared", count: 1 }))),
    "(() => {\n  return first:1;\n})()\n",
  );
  assert.equal(
    emitter.emit(program(second.make("number", { kind: "shared", count: 2 }))),
    "(() => {\n  return second:2;\n})()\n",
  );
  const foreign = custom();
  const foreignProgram = { ...program(first.make("number", { kind: "shared", count: 1 })) };
  assert.throws(
    () => createJavaScriptEmitter(defineJavaScriptBackend({ foreign }, { foreign: () => "" })).emit(foreignProgram),
    /Missing JavaScript handler/,
  );
  assert.throws(() => createJavaScriptEmitter(handlers, handlers), /Duplicate JavaScript handler/);
});

test("builtin backend tables emit with builder and feature descriptor instances", () => {
  const feature = records<string>();
  const builder = create<string>().use(feature);
  const value = builder.field(
    "number",
    builder.record("record", [{ name: "x", value: builder.literal("number", 42) }]),
    "x",
  );
  const program = builder.program(builder.body({ declarations: [], result: value }));
  assert.equal(
    Function(
      `return ${
        createJavaScriptEmitter(coreJavaScript(builder.coreDescriptors), recordsJavaScript(feature.descriptors)).emit(
          program,
        )
      }`,
    )(),
    42,
  );
  assert.throws(
    () => createJavaScriptEmitter(coreJavaScript(create<string>().coreDescriptors)).emit(program),
    /Missing JavaScript handler/,
  );
});

test("programs snapshot registries before later feature installation", () => {
  const builder = create<string>();
  const program = builder.program({ declarations: [], result: builder.literal("number", 1) });
  const count = program.operations.length;
  builder.use(records<string>());
  assert.equal(program.operations.length, count);
});

test("selected descriptors reject mutation after definition", () => {
  const descriptor = custom();
  const builder = create<string>().use({ methods: {}, descriptors: { custom: descriptor } });
  const value = descriptor.make("number", { kind: "shared", count: 42 });
  const program = builder.program({ declarations: [], result: value });
  assert.throws(() => {
    (descriptor as { id: symbol; }).id = Symbol("replacement");
  }, TypeError);
  assert.throws(() => {
    (descriptor as { children: unknown; }).children = () => [builder.literal("number", 0)];
  }, TypeError);
  assert.throws(() => {
    (descriptor as { references: unknown; }).references = () => [builder.binding("escaped", "number")];
  }, TypeError);
  assert.equal(program.operations.at(-1)!.id, value.operationId);
  const handlers = defineJavaScriptBackend({ custom: descriptor }, { custom: node => String(node.count) });
  assert.equal(Function(`return ${createJavaScriptEmitter(handlers).emit(program)}`)(), 42);
});

test("builders reject duplicate methods and descriptor identities", () => {
  const recordFeature = records<string>();
  const builder = create<string>().use(recordFeature);
  assert.throws(() => builder.use(records<string>()), /Duplicate language feature method/);
  assert.throws(
    () => builder.use({ descriptors: { alias: recordFeature.descriptors.record }, methods: {} }),
    /Duplicate operation descriptor/,
  );
});
