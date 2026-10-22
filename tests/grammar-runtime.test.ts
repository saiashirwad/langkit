import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { memoRules } from "../examples/grammar/grammar-analysis.ts";
import { type Checked, wire } from "../examples/grammar/grammar-model.ts";
import { checkSource } from "../examples/grammar/grammar.ts";
import { define } from "../examples/grammar/runtime.ts";

const header = "grammar G\nskip = /\\s+/\nword = /[a-z]+/\n";

const check = (source: string): Checked => {
  const checked = checkSource(source);
  assert.ok(checked.success, checked.success ? "" : checked.errors.map((error) => error.message).join("\n"));
  return checked.value;
};

/** Through the wire form, as an emitted module sees the grammar. */
const parser = (source: string) => define(wire(check(source))).parse;

const expression = parser(readFileSync(new URL("../examples/grammar/expr.grammar", import.meta.url), "utf8"));

type Node = { readonly kind: string; readonly [field: string]: unknown; };

const show = (node: Node): string => {
  switch (node.kind) {
    case "binary":
      return `(${show(node.left as Node)} ${node.operator} ${show(node.right as Node)})`;
    case "prefix":
      return `(${node.operator} ${show(node.operand as Node)})`;
    case "postfix":
      return `(${show(node.operand as Node)} ${node.operator})`;
    case "Num":
      return String(node.value);
    default:
      return [node.head, ...node.tail as string[]].join(".");
  }
};

const shown = (source: string): string => {
  const result = expression(source);
  return result.success ? show(result.value as Node) : result.errors[0].message.split("\n")[0]!;
};

test("precedence levels bind loosest first, with the declared associativity", () => {
  assert.equal(shown("a or b and not c == d"), "(a or (b and (not (c == d))))");
  assert.equal(shown("1 + 2 * 3 - 4"), "((1 + (2 * 3)) - 4)");
  assert.equal(shown("1 - 2 - 3"), "((1 - 2) - 3)");
  assert.equal(shown("-a * b"), "((- a) * b)");
  assert.equal(shown("- -a!"), "(- (- (a !)))");
  assert.equal(shown("not not a"), "(not (not a))");
  assert.equal(shown("a < b + 1 and c"), "((a < (b + 1)) and c)");
  assert.equal(shown("(1 + 2) * 3"), "((1 + 2) * 3)");
  assert.equal(shown("x.y.z"), "x.y.z");
});

test("a non-associative operator refuses to chain, and says so at the second operator", () => {
  const source = "a == b == c";
  const result = expression(source);
  assert.ok(!result.success);
  assert.equal(result.errors[0].message.split("\n")[0], "== cannot be chained; add parentheses");
  assert.equal(result.errors[0].span?.start, source.lastIndexOf("=="));
});

test("an operator with nothing after it fails the expression", () => {
  assert.ok(!expression("1 +").success);
  assert.ok(!expression("2 * (3").success);
});

test("arithmetic parses as JavaScript evaluates it", () => {
  const evaluate = (node: Node): number => {
    if (node.kind === "Num") return Number(node.value);
    if (node.kind === "prefix") return -evaluate(node.operand as Node);
    const [left, right] = [evaluate(node.left as Node), evaluate(node.right as Node)];
    return { "+": left + right, "-": left - right, "*": left * right, "/": left / right }[node.operator as string]!;
  };
  let seed = 7;
  const random = (limit: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % limit;
  const generate = (depth: number): string =>
    depth <= 0 || random(4) === 0
      ? String(random(9) + 1)
      : random(5) === 0
      ? `(${generate(depth - 1)})`
      : random(6) === 0
      ? `- ${generate(depth - 1)}`
      : `${generate(depth - 1)} ${["+", "-", "*", "/"][random(4)]} ${generate(depth - 1)}`;
  for (let i = 0; i < 2000; i++) {
    const source = generate(5);
    const result = expression(source);
    assert.ok(result.success, source);
    assert.equal(evaluate(result.value as Node), Function(`return (${source})`)() as number, source);
  }
});

test("a node spans its first token to its last, never the trivia around it", () => {
  const result = expression("  a.b  +  12  ");
  assert.ok(result.success);
  assert.deepEqual((result.value as Node).span, { start: 2, end: 12 });
  assert.deepEqual(((result.value as Node).left as Node).span, { start: 2, end: 5 });
});

const lists = parser(`${header}File = lines:Line+ "!" extra:(Name sepBy1 ",")? mode:("fast" | "slow")? groups:(Name+)*
Line = #pair left:ident "=" right:ident | #plain text:ident
Name = value:ident
`);

test("an absent optional list is empty, an absent optional literal is null", () => {
  const result = lists("a = b c !");
  assert.ok(result.success);
  const { extra, mode, groups, lines } = result.value as Node;
  assert.deepEqual([extra, mode, groups], [[], null, []]);
  assert.deepEqual((lines as Node[]).map(({ kind }) => kind), ["pair", "plain"]);
});

test("present optionals carry their values, and one-or-more lists carry at least one", () => {
  const result = lists("a ! x , y fast");
  assert.ok(result.success);
  const { extra, mode } = result.value as Node;
  assert.deepEqual((extra as Node[]).map(({ value }) => value), ["x", "y"]);
  assert.equal(mode, "fast");
  const groups = lists("a ! fast p q");
  assert.ok(groups.success);
  assert.deepEqual(((groups.value as Node).groups as Node[][]).map((group) => group.map(({ value }) => value)), [[
    "p",
    "q",
  ]]);
  assert.ok(!lists("!").success);
});

test("a keyword is a literal that matches the word pattern, and stays out of identifiers", () => {
  assert.deepEqual(check(`${header}A = #n "let" x:ident`).keywords, ["let"]);
  const parse = parser(`${header}A = #n "let" x:ident`);
  assert.ok(parse("let x").success);
  assert.ok(!parse("let let").success);
  assert.ok(!parse("letx").success);
});

test("deep nesting is a diagnostic at parse time, not a crash", () => {
  const parse = parser(`${header}E = #group "(" e:E ")" | #leaf n:ident`);
  const result = parse(`${"(".repeat(50_000)}x${")".repeat(50_000)}`);
  assert.ok(!result.success);
  assert.equal(result.errors[0].message, "Fatal: input nests too deeply to parse");
  assert.ok(parse("((x))").success);
});

const nested = (depth: number): string =>
  `${header}S = n:R0\n${
    Array.from({ length: depth }, (_, i) => {
      const next = i + 1 < depth ? `_:R${i + 1}` : "\"a\"";
      return `R${i} = #x ${next} "x" | #y ${next} "y"`;
    }).join("\n")
  }\n`;

test("rules that begin two alternatives are the ones memoized", () => {
  assert.deepEqual([...memoRules(check(nested(3)))], [2, 3]);
});

test("shared-prefix alternatives nested deeply parse in linear time", () => {
  const parse = parser(nested(22));
  const started = performance.now();
  const result = parse(`a${" y".repeat(22)}`);
  assert.ok(result.success);
  assert.ok(performance.now() - started < 300, "without memoizing this takes seconds");
});
