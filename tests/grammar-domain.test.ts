import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type * as H from "../examples/domain/domain-syntax.ts";
import { keywords, parse as handParse } from "../examples/domain/domain-syntax.ts";
import type * as G from "../examples/grammar/domain.grammar";
import { wire } from "../examples/grammar/grammar-model.ts";
import { checkSource } from "../examples/grammar/grammar.ts";
import { define } from "../examples/grammar/runtime.ts";

const checked = checkSource(readFileSync(new URL("../examples/grammar/domain.grammar", import.meta.url), "utf8"));
assert.ok(checked.success, checked.success ? "" : checked.errors.map((error) => error.message).join("\n"));
const generated = define(wire(checked.value)).parse;

const name = ({ name, span }: G.Name | G.FieldName): H.Name => ({ name, span });

const dataType = (type: G.DataType): H.TypeExpr => {
  switch (type.kind) {
    case "named":
      return { kind: "named", name: name(type.name), span: type.span };
    case "list":
      return { kind: "list", element: dataType(type.element), span: type.span };
    case "postfix":
      return { kind: "optional", inner: dataType(type.operand), span: type.span };
  }
};

const field = ({ name: id, type }: G.Field): H.Field => ({ name: name(id), type: dataType(type) });

const entry = (value: G.Entry): H.Entry =>
  value.kind === "spread"
    ? { kind: "spread", record: name(value.record) }
    : { kind: "field", field: field(value.field) };

const item = (value: G.MachineItem): H.MachineItem =>
  value.kind === "event"
    ? { kind: "event", sync: value.sync !== null, name: name(value.name), payload: value.payload.map(field) }
    : {
      kind: "state",
      name: name(value.name),
      role: value.marker?.role ?? "step",
      marker: value.marker?.span,
      entries: value.entries.map(entry),
      on: value.on.map(({ event, target, span }) => ({ event: name(event), target: name(target), span })),
    };

const port = ({ component, event, span }: G.Port): H.Port => ({ component: name(component), event: name(event), span });

/** The hand parser widens a parenthesized formula to its parentheses; here the group node already spans them. */
const formula = (value: G.Formula): H.FormulaExpr => {
  switch (value.kind) {
    case "is":
      return {
        kind: "is",
        component: name(value.component),
        negated: value.negated !== null,
        states: value.states.map(name),
        span: value.span,
      };
    case "group":
      return { ...formula(value.inner), span: value.span };
    case "binary":
      return { kind: value.operator, left: formula(value.left), right: formula(value.right), span: value.span };
  }
};

const claim = (value: G.Claim): H.ClaimExpr =>
  value.kind === "leadsTo"
    ? { kind: "leadsTo", from: formula(value.from), to: formula(value.to) }
    : { kind: value.kind, formula: formula(value.formula) };

const systemClause = (value: G.SystemClause): H.SystemClause => {
  switch (value.kind) {
    case "sync": {
      const [second, ...rest] = value.rest;
      return { kind: "sync", ports: [port(value.first), port(second), ...rest.map(port)], span: value.span };
    }
    case "fair":
      return { kind: "fair", component: name(value.component), span: value.span };
    case "property":
      return { kind: "property", name: name(value.name), claim: claim(value.claim), span: value.span };
  }
};

const declaration = (value: G.Declaration): H.Declaration => {
  switch (value.kind) {
    case "brand":
      return { kind: "brand", name: name(value.name), underlying: name(value.underlying) };
    case "type":
      return value.body.kind === "record"
        ? { kind: "record", name: name(value.name), fields: value.body.fields.map(field) }
        : {
          kind: "union",
          name: name(value.name),
          members: value.body.members.map((member) => ({
            name: name(member.name),
            fields: member.fields?.map(field),
          })),
        };
    case "machine":
      return { kind: "machine", name: name(value.name), items: value.items.map(item) };
    case "system":
      return {
        kind: "system",
        name: name(value.name),
        parts: value.parts.span,
        components: value.parts.components.map((part) => ({ name: name(part.name), machine: name(part.machine) })),
        clauses: value.clauses.map(systemClause),
      };
  }
};

/** The documented adapter: what the grammar's AST says, written in the hand parser's shape. */
const adapt = ({ imports, declarations }: G.File): H.File => ({
  imports: imports.map(({ names, path, span }) => ({ names: names.map(name), path: path.slice(1, -1), span })),
  declarations: declarations.map(declaration),
});

/** `Expected "}" or "x"` and `Expected "x" or "}"` name the same alternatives. */
const alternatives = (message: string): string => {
  const [expected, found = ""] = message.split("\n")[0]!.split(/(?=, found )/);
  return [...expected!.replace(/^Expected /, "").split(/ or (?=["/])/).sort(), found].join("\u0000");
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
    .replace(String(/"[^"\\\r\n]*"/), "Path");
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
 * token by its regex, and lists alternatives in its own order. And it commits at the `|>` of a system clause, then
 * chooses sync, fair or property; the grammar language cuts per alternative, three alternatives share `|>`, so a
 * bad clause keyword fails at the `|>` instead of at the keyword.
 */
test("error offsets and messages differ only where documented", () => {
  assert.deepEqual(tally.unexplained, []);
});
