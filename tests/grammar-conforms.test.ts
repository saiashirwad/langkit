import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { type Checked, type RuleId, ruleId, type Ty, wire } from "../examples/grammar/grammar-model.ts";
import { checkSource } from "../examples/grammar/grammar.ts";
import { define } from "../examples/grammar/runtime.ts";

const grammarOf = (name: string): Checked => {
  const checked = checkSource(readFileSync(new URL(`../examples/grammar/${name}`, import.meta.url), "utf8"));
  assert.ok(checked.success);
  return checked.value;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Does `value` have the shape the projected `.d.ts` promises? Reads the same `Ty` annotations the printer reads,
 * so the types and the runtime builder cannot drift apart unnoticed. `visiting` holds the rules already tried on
 * this same value, since a rule may pass itself through, as `Expr = "(" Expr ")"` does.
 */
const conforms = (grammar: Checked, ty: Ty, value: unknown, visiting: ReadonlySet<RuleId> = new Set()): boolean => {
  switch (ty.t) {
    case "text":
      return typeof value === "string";
    case "lits":
      return typeof value === "string" && ty.of.includes(value);
    case "rule":
      return conformsRule(grammar, ty.id, value, visiting);
    case "list":
      return Array.isArray(value) && (!ty.nonEmpty || value.length > 0)
        && value.every((element) => conforms(grammar, ty.of, element));
    case "maybe":
      return value === null || conforms(grammar, ty.of, value, visiting);
    case "union":
      return ty.of.some((member) => conforms(grammar, member, value, visiting));
  }
};

const conformsRule = (grammar: Checked, id: RuleId, value: unknown, visiting: ReadonlySet<RuleId>): boolean => {
  if (visiting.has(id)) return false;
  const rule = grammar.rules[id]!;
  const passing = new Set(visiting).add(id);
  return rule.pass.some((ty) => conforms(grammar, ty, value, passing)) || rule.variants.some((variant) => {
    if (!isRecord(value) || value.kind !== variant.kind) return false;
    const span = value.span;
    const spanned = isRecord(span) && typeof span.start === "number" && typeof span.end === "number"
      && span.start <= span.end;
    const keys = ["kind", "span", ...variant.fields.map(({ label }) => label)].sort();
    return spanned && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys)
      && variant.fields.every(({ label, ty }) => conforms(grammar, ty, value[label]));
  });
};

const corpus = (directory: string, extension: string): readonly string[] =>
  readdirSync(new URL(`../examples/${directory}/`, import.meta.url)).filter((file) => file.endsWith(extension)).map(
    (file) => readFileSync(new URL(`../examples/${directory}/${file}`, import.meta.url), "utf8"),
  );

test("every AST the runtime builds from the domain corpus has the shape the projection declares", () => {
  const grammar = grammarOf("domain.grammar");
  const parse = define(wire(grammar)).parse;
  let checked = 0;
  for (const source of corpus("domain", ".domain")) {
    for (let length = 0; length <= source.length; length += 7) {
      const result = parse(source.slice(0, length));
      if (!result.success) continue;
      assert.ok(conforms(grammar, { t: "rule", id: ruleId(0) }, result.value), `prefix ${length}`);
      checked++;
    }
  }
  assert.ok(checked > 100, `${checked} accepted inputs`);
});

test("every AST the runtime builds from the expression corpus has the shape the projection declares", () => {
  const grammar = grammarOf("expr.grammar");
  const parse = define(wire(grammar)).parse;
  const inputs = ["1", "a.b", "1 + 2 * 3", "-a!", "not a == b", "(1 + 2) * x.y.z", "a or b and c < d - 1"];
  for (const input of inputs) {
    const result = parse(input);
    assert.ok(result.success, input);
    assert.ok(conforms(grammar, { t: "rule", id: ruleId(0) }, result.value), input);
  }
});

test("a value that breaks the declared shape is caught", () => {
  const grammar = grammarOf("expr.grammar");
  const num = { kind: "Num", value: "1", span: { start: 0, end: 1 } };
  assert.ok(conforms(grammar, { t: "rule", id: ruleId(0) }, num));
  assert.ok(!conforms(grammar, { t: "rule", id: ruleId(0) }, { ...num, value: 1 }));
  assert.ok(!conforms(grammar, { t: "rule", id: ruleId(0) }, { ...num, extra: true }));
  assert.ok(!conforms(grammar, { t: "rule", id: ruleId(0) }, { kind: "binary", operator: "%", left: num, right: num }));
});
