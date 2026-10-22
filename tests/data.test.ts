import { run } from "langkit";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assignable, type DataType, same, showType, showTypeDecl, typeKey } from "../examples/data/data-model.ts";
import {
  type Binder,
  elaborateTypes,
  resolveType,
  type Scope,
  type TypeDeclaration,
  type TypeExpr,
  typescript,
} from "../examples/data/data-types.ts";

const span = { start: 0, end: 0 };
const named = (name: string): TypeExpr => ({ kind: "named", name: { name, span }, span });
const list = (element: TypeExpr, max?: number): TypeExpr => ({
  kind: "list",
  element,
  max: max === undefined ? undefined : { value: max, span: { start: 7, end: 8 } },
  span,
});
const optional = (inner: TypeExpr): TypeExpr => ({ kind: "optional", inner, span });

const step: Binder = {
  kind: "type",
  id: Symbol("Step"),
  key: typeKey("file:///t", "Step"),
  uri: "file:///t",
  name: { name: "Step", span },
};
const scope: Scope = {
  uri: "file:///t",
  top: new Map([["Step", step]]),
  universe: new Map(),
  dialect: { reserved: typescript, variants: "parens" },
};

const resolve = (type: TypeExpr) => {
  const result = run(resolveType(scope, type));
  return result.success ? showType(result.value) : result.errors.map(({ message, span }) => ({ message, span }));
};

const resolved = (type: TypeExpr): DataType => {
  const result = run(resolveType(scope, type));
  assert.ok(result.success);
  return result.value;
};

test("a list resolves with its bound, and an unbounded list prints without one", () => {
  assert.equal(resolve(list(named("Step"), 3)), "[Step; ..3]");
  assert.equal(resolve(list(named("Step"))), "[Step]");
  assert.equal(resolve(optional(list(named("Int"), 1))), "[Int; ..1]?");
  const unbounded = resolved(list(named("Step")));
  assert.ok(unbounded.kind === "list" && unbounded.max === Infinity);
});

test("a bounded list holds at least one element, reported at the bound", () => {
  assert.deepEqual(resolve(list(named("Step"), 0)), [
    { message: "A bounded list holds at least one element", span: { start: 7, end: 8 } },
  ]);
});

test("a bound is part of a list's type, and a shorter bound fits a longer one", () => {
  const [three, two, unbounded] = [list(named("Step"), 3), list(named("Step"), 2), list(named("Step"))].map(resolved);
  assert.equal(same(three!, three!), true);
  assert.equal(same(three!, two!), false);
  assert.equal(same(three!, unbounded!), false);
  assert.equal(assignable(two!, three!), true);
  assert.equal(assignable(three!, two!), false);
  assert.equal(assignable(three!, unbounded!), true);
  assert.equal(assignable(unbounded!, three!), false);
  assert.equal(assignable(two!, resolved(optional(list(named("Step"), 3)))), true);
  assert.equal(assignable(resolved(list(named("Int"), 2)), three!), false);
});

test("an optional accepts its inner type and itself, never the reverse", () => {
  const [inner, outer] = [named("Step"), optional(named("Step"))].map(resolved);
  assert.equal(assignable(inner!, outer!), true);
  assert.equal(assignable(outer!, outer!), true);
  assert.equal(assignable(outer!, inner!), false);
});

test("a variant payload prints in the dialect's own syntax", () => {
  const declaration: TypeDeclaration = {
    kind: "union",
    name: step.name,
    members: [
      { name: { name: "Loop", span }, fields: [{ name: { name: "count", span }, type: named("Int") }] },
      { name: { name: "Rest", span }, fields: undefined },
    ],
  };
  const result = run(elaborateTypes(scope, [[declaration, step]]));
  assert.ok(result.success);
  assert.equal(showTypeDecl(result.value[0]!, "parens"), "type Step = Loop(count : Int) | Rest");
  assert.equal(showTypeDecl(result.value[0]!, "braces"), "type Step = Loop { count : Int } | Rest");
});
