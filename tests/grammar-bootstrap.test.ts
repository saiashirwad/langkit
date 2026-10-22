import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { wire } from "../examples/grammar/grammar-model.ts";
import type * as S from "../examples/grammar/grammar-syntax.ts";
import { parse as handParse } from "../examples/grammar/grammar-syntax.ts";
import type * as G from "../examples/grammar/grammar.grammar";
import { checkSource } from "../examples/grammar/grammar.ts";
import { define } from "../examples/grammar/runtime.ts";
import { cases, header } from "./grammar-cases.ts";

const checked = checkSource(readFileSync(new URL("../examples/grammar/grammar.grammar", import.meta.url), "utf8"));
assert.ok(checked.success, checked.success ? "" : checked.errors.map((error) => error.message).join("\n"));
const generated = define(wire(checked.value)).parse;

const name = ({ name, span }: G.Name): S.Name => ({ name, span });
const text = ({ text, span }: G.Text): { readonly text: string; readonly span: S.Name["span"]; } => ({
  text: JSON.parse(text) as string,
  span,
});
const pattern = ({ source, span }: G.Regex): S.Pattern => ({ source: source.slice(1, -1), span });

const expression = (value: G.Separated): S.Expr => {
  switch (value.kind) {
    case "sep":
      return {
        kind: "sep",
        op: value.op.keyword,
        item: expression(value.item),
        sep: expression(value.separator),
        span: value.span,
      };
    case "postfix":
      return { kind: "rep", op: value.operator, expr: expression(value.operand), span: value.span };
    case "predicate":
      return { kind: "pred", op: value.op, expr: expression(value.operand), span: value.span };
    case "text":
      return { kind: "lit", ...text(value.value), span: value.span };
    case "regex":
      return { kind: "re", source: pattern(value.value).source, span: value.span };
    case "cut":
      return { kind: "cut", span: value.span };
    case "group":
      return { kind: "group", alts: alternatives(value.alts), span: value.span };
    case "ref":
      return { kind: "ref", name: name(value.name), span: value.span };
  }
};

const alternative = (value: G.Alt): S.Alt => ({
  tag: value.kind === "tagged" ? name(value.tag) : undefined,
  elems: value.elems.map(({ label, expr }) => ({ label: label ? name(label) : undefined, expr: expression(expr) })),
  span: value.span,
});

const alternatives = ({ alts }: G.Alts): readonly S.Alt[] => alts.map(alternative);

const body = (value: G.Body): S.Body =>
  value.kind === "levels"
    ? {
      kind: "precedence",
      levels: value.levels.map(({ assoc, operators, span }) => ({ assoc, ops: operators.map(text), span })),
      atoms: alternatives(value.atoms),
    }
    : { kind: "alts", alts: alternatives(value.alts) };

const item = (value: G.Item): S.Item => {
  switch (value.kind) {
    case "trivia":
      return { kind: "skip", patterns: value.patterns.map(pattern), span: value.span };
    case "identifier":
      return { kind: "word", pattern: pattern(value.pattern), span: value.span };
    case "named":
      return { kind: "token", name: name(value.name), pattern: pattern(value.pattern), span: value.span };
    case "rule":
      return { kind: "rule", name: name(value.name), body: body(value.body), span: value.name.span };
  }
};

/** The documented adapter: the grammar's AST in the shape grammar-syntax.ts builds by hand. */
const adapt = (file: G.File): S.File => ({ name: name(file.name), items: file.items.map(item) });

const directory = new URL("../examples/grammar/", import.meta.url);
const sources = [
  ...readdirSync(directory).filter((file) => file.endsWith(".grammar")).map((file) =>
    readFileSync(new URL(file, directory), "utf8")
  ),
  ...cases.map(({ body }) => `${header}${body}\n`),
];

const insertions = [
  "|",
  "=",
  "(",
  ")",
  "{",
  "}",
  "~",
  "#",
  "*",
  "+",
  "?",
  "&",
  "!",
  ":",
  "sepBy",
  "sepBy1",
  "precedence",
  "atom",
  "left",
  "skip",
  "word",
  "token",
  "grammar",
  "\"x\"",
  "/x/",
] as const;

const tally = { inputs: 0, accepted: 0, rejected: 0, disagreements: [] as string[], different: [] as string[] };
const offsets = { differing: 0, unexplained: [] as string[] };

const compare = (input: string, label: string): void => {
  tally.inputs++;
  const hand = handParse(input);
  const ours = generated(input);
  if (hand.success !== ours.success) {
    tally.disagreements.push(label);
    return;
  }
  if (hand.success && ours.success) {
    tally.accepted++;
    try {
      assert.deepStrictEqual(adapt(ours.value as G.File), hand.value);
    } catch {
      tally.different.push(label);
    }
    return;
  }
  tally.rejected++;
  const [expected] = hand.success ? [] : hand.errors;
  const [actual] = ours.success ? [] : ours.errors;
  if (expected?.span?.start === actual?.span?.start) return;
  offsets.differing++;
  const explained = expected?.message === "expected a sequence" && actual?.span && expected.span
    && actual.span.start >= expected.span.start;
  if (!explained) {
    offsets.unexplained.push(
      `${label}: ${expected?.span?.start} ${expected?.message} | ${actual?.span?.start} ${actual?.message}`,
    );
  }
};

let seed = 42;
const random = (limit: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % limit;
for (const [index, source] of sources.entries()) {
  compare(source, `source ${index}`);
  for (let length = 0; length < source.length; length++) {
    compare(source.slice(0, length), `source ${index} prefix ${length}`);
  }
  const words = source.split(/(\s+)/);
  for (let mutant = 0; mutant < 30; mutant++) {
    const mutated = [...words];
    const at = random(mutated.length);
    switch (random(4)) {
      case 0:
        mutated.splice(at, 1);
        break;
      case 1:
        mutated.splice(at, 0, mutated[random(mutated.length)]!);
        break;
      case 2: {
        const other = random(mutated.length);
        [mutated[at], mutated[other]] = [mutated[other]!, mutated[at]!];
        break;
      }
      default:
        mutated[at] = insertions[random(insertions.length)]!;
    }
    compare(mutated.join(""), `source ${index} mutant ${mutant}`);
  }
}

test("grammar.grammar is a valid grammar and parses itself", () => {
  const source = readFileSync(new URL("grammar.grammar", directory), "utf8");
  const parsed = generated(source);
  assert.ok(parsed.success);
  assert.equal((parsed.value as G.File).items.length, 4 + checked.value.rules.length);
});

test("grammar.grammar accepts and rejects exactly what grammar-syntax.ts does", (t) => {
  t.diagnostic(
    `${tally.inputs} inputs: ${tally.accepted} accepted by both, ${tally.rejected} rejected by both; `
      + `${offsets.differing} error offsets differ`,
  );
  assert.ok(tally.accepted > 100 && tally.rejected > 1000);
  assert.deepEqual(tally.disagreements, []);
});

test("every accepted input has the same AST, spans included, through the adapter", () => {
  assert.deepEqual(tally.different, []);
});

/**
 * One difference is documented and the rest must be none. When an element fails after its label, the hand parser
 * reports "expected a sequence" at the start of the alternative; the grammar reports what it expected at the
 * furthest point it reached, which is never earlier.
 */
test("error offsets agree, except where the grammar reports further on", () => {
  assert.deepEqual(offsets.unexplained.slice(0, 10), []);
});
