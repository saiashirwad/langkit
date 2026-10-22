import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { keywords, parse as handParse } from "../examples/domain/domain-syntax.ts";
import type * as G from "../examples/grammar/domain.grammar";
import { wire } from "../examples/grammar/grammar-model.ts";
import { checkSource } from "../examples/grammar/grammar.ts";
import { define } from "../examples/grammar/runtime.ts";
import { adapt } from "./grammar-domain-adapter.ts";

const checked = checkSource(readFileSync(new URL("../examples/grammar/domain.grammar", import.meta.url), "utf8"));
assert.ok(checked.success, checked.success ? "" : checked.errors.map((error) => error.message).join("\n"));
const generated = define(wire(checked.value)).parse;

/** `Expected "}" or "x"` and `Expected "x" or "}"` name the same alternatives. */
const alternatives = (message: string): string => {
  const [expected, found = ""] = message.split("\n")[0]!.split(/(?=, found )/);
  return [...expected!.replace(/^Expected /, "").split(/ or (?=["/]|a name)/).sort(), found].join("\u0000");
};

type Tally = {
  inputs: number;
  accepted: number;
  rejected: number;
  disagreements: string[];
  astDifferences: string[];
  offsetDifferences: number;
  messageDifferences: number;
  unexplained: string[];
};

const tally: Tally = {
  inputs: 0,
  accepted: 0,
  rejected: 0,
  disagreements: [],
  astDifferences: [],
  offsetDifferences: 0,
  messageDifferences: 0,
  unexplained: [],
};

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
      tally.astDifferences.push(label);
    }
    return;
  }
  tally.rejected++;
  const [expected] = hand.success ? [] : hand.errors;
  const [actual] = ours.success ? [] : ours.errors;
  if (!expected || !actual) return;
  const generic = expected.message
    .replace(/closing delimiter/g, JSON.stringify(/"([})\]])"/.exec(actual.message)?.[1]))
    .replace(String(/"[^"\\\r\n]*"/), "Path")
    .replace(String(/[a-zA-Z_][a-zA-Z_0-9]*/), "a name");
  if (expected.span?.start !== actual.span?.start) {
    tally.offsetDifferences++;
    const atClause = input.startsWith("|>", actual.span?.start) && expected.message.startsWith("Expected \"sync\" or");
    if (!atClause) tally.unexplained.push(label);
  } else if (alternatives(generic) !== alternatives(actual.message)) {
    tally.messageDifferences++;
    tally.unexplained.push(label);
  }
};

const files = readdirSync(new URL("../examples/domain/", import.meta.url)).filter((file) => file.endsWith(".domain"));

const mutants = 800;
const insertions = [
  "{",
  "}",
  ",",
  ":",
  "|>",
  "->",
  "~>",
  "?",
  "[",
  "]",
  "=",
  "state",
  "on",
  "...",
  "(",
  ")",
  "|",
  "//",
  "is",
  "not",
  "and",
  "or",
  ".",
  "sync",
  "event",
  "never",
  "property",
  "import",
  "from",
] as const;

for (const file of files) {
  const source = readFileSync(new URL(`../examples/domain/${file}`, import.meta.url), "utf8");
  compare(source, file);
  for (let length = 0; length < source.length; length++) compare(source.slice(0, length), `${file} prefix ${length}`);
  let seed = 42;
  const random = (limit: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % limit;
  const words = source.split(/(\s+)/);
  for (let index = 0; index < mutants; index++) {
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
    compare(mutated.join(""), `${file} mutant ${index}`);
  }
}

test("the grammar's keywords are the hand parser's keywords", () => {
  assert.deepEqual([...checked.value.keywords].sort(), [...keywords].sort());
});

test("domain.grammar accepts and rejects exactly what domain-syntax.ts does", (t) => {
  t.diagnostic(
    `${tally.inputs} inputs: ${tally.accepted} accepted by both, ${tally.rejected} rejected by both; `
      + `${tally.offsetDifferences} error offsets differ, ${tally.messageDifferences} messages differ beyond the documented ones`,
  );
  assert.ok(tally.accepted > 3000 && tally.rejected > 3000);
  assert.deepEqual(tally.disagreements, []);
});

test("every accepted input has the same AST, spans included, through the adapter", () => {
  assert.deepEqual(tally.astDifferences, []);
});

/**
 * Documented, and nothing else. The hand parser names every `between` closer "closing delimiter", names the path
 * token and identifiers by their regex, and lists alternatives in its own order. And it commits at the `|>` of a system clause, then
 * chooses sync, fair or property; the grammar language cuts per alternative, three alternatives share `|>`, so a
 * bad clause keyword fails at the `|>` instead of at the keyword.
 */
test("error offsets and messages differ only where documented", () => {
  assert.deepEqual(tally.unexplained, []);
});

test("deeply nested types parse, and nesting past the stack is a diagnostic, not a crash", () => {
  const nested = (depth: number) => `type T = { a : ${"[".repeat(depth)}String${"]".repeat(depth)} }\n`;
  assert.ok(generated(nested(100)).success);
  const deep = generated(nested(50_000));
  assert.ok(!deep.success);
  assert.equal(deep.errors[0].message, "Fatal: input nests too deeply to parse");
});
