import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { run } from "../src/check.ts";
import { elaboration } from "../src/ir/check.ts";
import { create, mapBody, validate, type Body, type OperationNode, type Value } from "../src/ir.ts";
import { emit, createJavaScriptEmitter, type JavaScriptContext } from "../src/javascript.ts";
import { coreJavaScript } from "../src/javascript/core.ts";
import { printingJavaScript } from "../src/javascript/printing.ts";
import { asDispatcherHandler, defineJavaScriptHandler } from "../src/javascript/operations.ts";
import { defineOperation, traversalOf } from "../src/operations/descriptor.ts";
import { records } from "../src/operations/records.ts";
import { printing } from "../src/operations/printing.ts";
test("language builders compose explicitly selected feature methods", () => {
  const recordSet = records<string>();
  const language = create<string>().use(recordSet).use(printing<string>());
  const record = language.record("record", [{ name: "n", value: language.literal("number", 1) }]);
  const selected = language.field("number", record, "n");
  assert.equal(selected.operationId, recordSet.operations.find((operation) => operation.kind === "field")?.id);
  assert.throws(() => create<string>().use({ methods: { program: () => undefined }, descriptors: {}, operations: [] }), /Duplicate language feature method: program/);
});

test("custom operation traversal rejects a binding that escapes its scope", () => {
  type ScopeNode = OperationNode & { readonly kind: "scope-test"; readonly child: Value<string>; readonly body: Body<string> };
  const descriptor = defineOperation<string, ScopeNode>("scope-test", {
    children: (node) => [node.child],
    scopedBodies: (node) => [{ body: node.body, bindings: [] }],
    references: () => [],
    map: (node, value, body) => ({ ...node, child: value(node.child), body: body(node.body) }),
  });
  const base = create<string>();
  const escaped = base.binding("escaped", "number");
  const language = base.use({
    methods: { scopeTest: (type: string, node: ScopeNode) => descriptor.make(type, node) },
    descriptors: { scopeTest: descriptor },
    operations: [traversalOf(descriptor)],
  });
  const custom = language.scopeTest("number", {
    kind: "scope-test",
    child: base.ref(escaped),
    body: { declarations: [], result: language.literal("number", 0) },
  });
  assert.throws(() => language.validate({ declarations: [], result: custom }), /Out-of-scope binding: escaped/);
});

test("custom operation structural validation runs through generic validation", () => {
  type MetadataNode = OperationNode & { readonly kind: "metadata-test"; readonly entries: readonly string[] };
  const descriptor = defineOperation<string, MetadataNode>("metadata-test", {
    children: () => [],
    scopedBodies: () => [],
    references: () => [],
    map: (node) => node,
    validate: (node) => {
      if (new Set(node.entries).size !== node.entries.length) throw new Error("Duplicate metadata entry");
    },
  });
  const base = create<string>();
  const language = base.use({
    methods: { metadataTest: (type: string, node: MetadataNode) => descriptor.make(type, node) },
    descriptors: { metadataTest: descriptor },
    operations: [traversalOf(descriptor)],
  });
  const malformed = language.metadataTest("test", { kind: "metadata-test", entries: ["same", "same"] });
  assert.throws(() => language.validate({ declarations: [], result: malformed }), /Duplicate metadata entry/);
});

test("custom JavaScript dispatch rejects missing handlers and supports explicit composition", () => {
  type CustomNode = OperationNode & { readonly kind: "custom-text"; readonly text: string };
  const descriptor = defineOperation<string, CustomNode>("custom-text", {
    children: () => [],
    scopedBodies: () => [],
    references: () => [],
    map: (node) => node,
  });
  const value = descriptor.make("string", { kind: "custom-text", text: "custom" });
  const root: Body<string> = { declarations: [], result: value };
  const base = create<string>();
  const language = base.use({ methods: {}, descriptors: { customText: descriptor }, operations: [traversalOf(descriptor)] });
  const program = language.program(root);
  assert.throws(() => emit(program), /Missing JavaScript handler for operation: custom-text/);

  const handler = asDispatcherHandler(defineJavaScriptHandler<string, CustomNode, JavaScriptContext<string>>(
    descriptor,
    (node) => JSON.stringify(node.text),
  ));
  assert.throws(() => createJavaScriptEmitter([handler], [handler]), /Duplicate JavaScript handler: custom-text/);
  const transformed = mapBody(program.body, program.operations, undefined, (original, mapped) =>
    original.operationId === descriptor.id
      ? { ...mapped, node: { ...(mapped.node as CustomNode), text: "transformed" } }
      : mapped,
  );
  const transformedProgram = { ...program, body: transformed };
  validate(transformedProgram);
  assert.equal(runInNewContext(emit(transformedProgram, [handler])), "transformed");
});

test("composed operations preserve left-to-right evaluation order", () => {
  const printSet = printing<string>();
  const language = create<string>().use(printSet);
  const num = (value: number) => language.literal("number", value);
  const effect = (label: string, result: Value<string>): Value<string> => {
    const parameter = language.binding("unused", "number");
    return language.call("number", language.fn("function", parameter, {
      declarations: [{ binding: language.binding(`printed-${label}`, "unit"), value: language.print("unit", language.literal("string", label)) }],
      result,
    }), num(0));
  };
  const root: Body<string> = {
    declarations: [],
    result: language.binary("number", "+", effect("left", num(1)), effect("right", num(2))),
  };
  const log: string[] = [];
  const javascript = createJavaScriptEmitter(
    coreJavaScript(language.coreDescriptors),
    printingJavaScript(printSet.descriptors),
  );
  assert.equal(runInNewContext(javascript.emit(language.program(root)), { console: { log: (message: string) => log.push(message) } }), 3);
  assert.deepEqual(log, ["left", "right"]);
});

test("recursive programs carry their core function identity through validation and emission", () => {
  const language = create<string>();
  const backend = createJavaScriptEmitter(coreJavaScript(language.coreDescriptors));
  const num = (value: number) => language.literal("number", value);
  const empty = (result: Value<string>): Body<string> => ({ declarations: [], result });
  const code = elaboration(language);
  const built = run(code.body(function* () {
    const factorial = language.binding("factorial", "number -> number");
    const n = language.binding("n", "number");
    const fn = language.fn(factorial.type, n, empty(language.conditional(
      "number",
      language.binary("boolean", "==", language.ref(n), num(0)),
      empty(num(1)),
      empty(language.binary("number", "*", language.ref(n), language.call(
        "number", language.ref(factorial), language.binary("number", "-", language.ref(n), num(1)),
      ))),
    )));
    const reference = yield* code.declareRecursive(factorial, fn);
    return language.call("number", reference, num(5));
  }));
  assert.equal(built.success, true);
  if (!built.success) return;
  const program = language.program(built.value);
  validate(program);
  assert.equal(runInNewContext(backend.emit(program)), 120);
});
