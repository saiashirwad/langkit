import { type Diagnostic, render, type Result } from "langkit";
import { type Analysis, highlight, unanalyzed } from "langkit/analysis";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { audit, type Finding, memoRules, nullableRules } from "./grammar-analysis.ts";
import { type Elaborated, error, lower } from "./grammar-elaborate.ts";
import { facts, type Type } from "./grammar-facts.ts";
import { type Checked, ruleId } from "./grammar-model.ts";
import { derive } from "./grammar-shape.ts";
import * as S from "./grammar-syntax.ts";

const describe = (finding: Finding, grammar: Checked): Diagnostic => {
  const name = (id: number) => grammar.rules[id]!.name;
  switch (finding.kind) {
    case "left recursion": {
      const path = [...finding.cycle, finding.cycle[0]!].map(name).join(" -> ");
      return error(
        `Left recursion: ${path}. Consume a token first, or use a repetition or a precedence block`,
        finding.sites[0]!,
      );
    }
    case "nullable loop":
      return error(
        `This ${
          finding.loop === "repeat" ? "repetition" : "list item"
        } can match nothing, so the loop would never advance`,
        finding.span,
      );
    case "shadowed":
      return error(`Unreachable alternative: ${shadowReason[finding.why]}`, finding.alt);
    case "unused rule":
      return error(
        `Unused rule: ${name(finding.rule)} is not reachable from ${name(0)}`,
        grammar.rules[finding.rule]!.span,
      );
    case "unused token":
      return error(`Unused token: ${finding.name}`, finding.span);
  }
};

const shadowReason = {
  "always succeeds": "an earlier alternative always succeeds",
  "same alternative": "an earlier alternative is the same",
  "prefix": "an earlier alternative already matches everything this one starts with",
  "commits": "an earlier alternative commits with ~ after the same start",
} as const;

export const elaborate = (file: S.File): Elaborated => {
  const lowered = lower(file);
  const derived = derive(lowered.grammar);
  const resolved = !lowered.errors.length;
  return {
    grammar: derived.grammar,
    errors: resolved
      ? [...derived.errors, ...audit(derived.grammar).map((finding) => describe(finding, derived.grammar))]
      : lowered.errors,
  };
};

const bySpan = (a: Diagnostic, b: Diagnostic): number => (a.span?.start ?? 0) - (b.span?.start ?? 0);

const elaborated = (source: string): Result<Elaborated> => {
  const parsed = S.parse(source);
  return parsed.success ? { success: true, value: elaborate(parsed.value) } : parsed;
};

/** The compile path: syntax, names, node types, then the grammar audit. Every finding is an error. */
export const checkSource = (source: string): Result<Checked> => {
  const result = elaborated(source);
  if (!result.success) return result;
  const [first, ...rest] = result.value.errors.toSorted(bySpan);
  return first ? { success: false, errors: [first, ...rest] } : { success: true, value: result.value.grammar };
};

export type { Type };

export const show = (type: Type): string => type;

/** The LSP entry: facts survive resolution and type errors, so an editor keeps hover and links while a grammar is broken. */
export const analyze = (source: string): Analysis<Type> => {
  const lexical = highlight(source, S.tokens);
  const result = elaborated(source);
  if (!result.success) return unanalyzed(result.errors, lexical);
  const { grammar, errors } = result.value;
  return { ...facts(grammar), diagnostics: errors.toSorted(bySpan), tokens: lexical };
};

const summary = (grammar: Checked): string => {
  const nullable = nullableRules(grammar);
  const memoized = memoRules(grammar);
  const width = Math.max(...grammar.rules.map(({ name }) => name.length));
  const kinds = ({ variants, pass }: Checked["rules"][number]) =>
    [...variants.map(({ kind }) => kind), ...(pass.length ? ["passes through"] : [])].join(" | ") || "captures nothing";
  const flags = (id: number) => [nullable[id] ? "can match nothing" : "", memoized.has(ruleId(id)) ? "memoized" : ""];
  return [
    `${grammar.name.name}: ${grammar.rules.length} rules, ${grammar.keywords.length} keywords`,
    ...grammar.rules.map((rule, id) =>
      [`  ${rule.name.padEnd(width)}  ${kinds(rule)}`, ...flags(id).filter(Boolean)].join("; ")
    ),
  ].join("\n");
};

if (import.meta.main) {
  const path = process.argv[2] ? resolve(process.argv[2]) : new URL("./domain.grammar", import.meta.url).pathname;
  const source = readFileSync(path, "utf8");
  const result = checkSource(source);
  if (result.success) console.log(summary(result.value));
  else {
    for (const error of result.errors) console.error(`${path}: ${render(error, source)}`);
    process.exitCode = 1;
  }
}
