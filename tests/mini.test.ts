import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { hm, higherRank } from "../examples/elaboration/mini.ts";
import { definitionAt, typeAt } from "../src/analysis.ts";
import { traceAt } from "../src/trace.ts";

test("shared parser and HM rows compile let-polymorphic identity to executable JavaScript", () => {
  const outcome = hm.elaborate("let id = fn x => x; (id(1), id(true))");
  assert.equal(outcome.status, "checked", JSON.stringify(outcome.diagnostics));
  if (outcome.status !== "checked") return;
  assert.deepEqual(JSON.parse(JSON.stringify(runInNewContext(hm.emit(outcome.artifact)))), { _1: 1, _2: true });
  assert.equal(outcome.partial.type, "{ _1: number, _2: boolean }");
});
test("rows infer polymorphic projection using the supported row solver", () => {
  const outcome = hm.elaborate("let getX = fn r => r.x; (getX({ x: 1, y: true }), getX({ x: true }))");
  assert.equal(outcome.status, "checked", JSON.stringify(outcome.diagnostics));
  if (outcome.status !== "checked") return;
  assert.deepEqual(JSON.parse(JSON.stringify(runInNewContext(hm.emit(outcome.artifact)))), { _1: 1, _2: true });
});
test("predicative higher rank accepts explicit forall parameters and emits a callable function", () => {
  const outcome = higherRank.elaborate("fn (f: forall a. a -> a) => (f(1), f(true))");
  assert.equal(outcome.status, "checked", JSON.stringify(outcome.diagnostics));
  if (outcome.status !== "checked") return;
  const result = runInNewContext(`(${higherRank.emit(outcome.artifact)})(x=>x)`);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { _1: 1, _2: true });
  assert.match(outcome.partial.type, /forall a/);
});
test("HM rejects forall and monomorphic parameter uses do not become implicit polymorphism", () => {
  assert.equal(hm.elaborate("fn (f: forall a. a -> a) => (f(1), f(true))").status, "failed");
  for (const compiler of [hm, higherRank]) {
    const outcome = compiler.elaborate("fn f => (f(1), f(true))");
    assert.equal(outcome.status, "recovered");
    assert(outcome.diagnostics.length > 0);
    assert.equal(outcome.facts.analysis.definitions.length, 1);
    assert.equal(outcome.facts.analysis.references.length, 2);
  }
});
test("expected forall opens before a specialized lambda check", () => {
  const outcome = higherRank.elaborate("(fn x => x): forall a. a -> a");
  assert.equal(outcome.status, "checked", JSON.stringify(outcome.diagnostics));
  if (outcome.status !== "checked") return;
  assert.equal(runInNewContext(`(${higherRank.emit(outcome.artifact)})(42)`), 42);
  assert(outcome.facts.trace.some((event) => event.rule === "fn.check" && event.expected?.includes("forall")));
});
test("explicit polymorphic argument is checked, not unified as an inferred monotype", () => {
  const source = "(fn (f: forall a. a -> a) => (f(1), f(true)))(fn x => x)";
  const outcome = higherRank.elaborate(source);
  assert.equal(outcome.status, "checked", JSON.stringify(outcome.diagnostics));
  if (outcome.status !== "checked") return;
  assert.deepEqual(JSON.parse(JSON.stringify(runInNewContext(higherRank.emit(outcome.artifact)))), { _1: 1, _2: true });
});
test("rigid escaping solutions fail and recovered editor facts remain usable", () => {
  const outcome = higherRank.elaborate("fn x => ((fn y => x): forall a. a -> a)");
  assert.notEqual(outcome.status, "checked");
  assert(outcome.diagnostics.length > 0);
  assert(outcome.facts.analysis.definitions.some((definition) => definition.name === "x"));
});
test("a hole publishes partial terms but cannot reach normal emission", () => {
  const outcome = hm.elaborate("let x = 1; (x, ?)");
  assert.equal(outcome.status, "recovered");
  if (outcome.status !== "recovered") return;
  assert.match(outcome.partial.term, /undefined/);
  assert.equal(outcome.diagnostics[0]!.code, "mini.hole");
  assert.equal("artifact" in outcome, false);
});
test("expression selection exposes types, expected types, navigation and real constraints", () => {
  const source = "let id = fn x => x; (id(1), id(true))";
  const outcome = hm.elaborate(source);
  assert.equal(outcome.status, "checked");
  const offset = source.indexOf("id(1)");
  assert.equal(definitionAt(outcome.facts.analysis, offset)?.name, "id");
  assert.match(typeAt(outcome.facts.analysis, offset)?.type ?? "", /number -> number/);
  const events = traceAt(outcome.facts.trace, source.indexOf("true"));
  assert(events.some((event) => event.expected === "boolean"));
  assert(events.some((event) => event.relation === "subsume" && event.reason));
  const definitions = outcome.facts.analysis.definitions.filter((definition) => definition.name === "id");
  const references = outcome.facts.analysis.references.filter((reference) => reference.id === definitions[0]!.id);
  assert.equal(references.length, 2);
});
test("compiler recipes isolate sessions and preserve previously published facts", () => {
  const first = hm.elaborate("let id = fn x => x; id(1)");
  const snapshot = JSON.stringify(first.facts);
  const second = hm.elaborate("let id = fn x => x; id(true)");
  assert.equal(first.status, "checked");
  assert.equal(second.status, "checked");
  assert.equal(JSON.stringify(first.facts), snapshot);
  assert.notEqual(first.facts.analysis.definitions[0]!.id, second.facts.analysis.definitions[0]!.id);
});
