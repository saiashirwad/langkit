import type { Diagnostic, Result } from "langkit";
import { audit, type Finding } from "./grammar-analysis.ts";
import { type Elaborated, error, lower } from "./grammar-elaborate.ts";
import type { Checked } from "./grammar-model.ts";
import { derive } from "./grammar-shape.ts";
import * as S from "./grammar-syntax.ts";
import { guarded } from "./runtime.ts";

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

/** Resolve names, derive node types, then audit; independent errors are reported together. */
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

/** The compile path: syntax, names, node types, then the grammar audit. Every finding is an error. */
export const checkSource = (source: string): Result<Checked> =>
  guarded(() => {
    const parsed = S.parse(source);
    if (!parsed.success) return parsed;
    const { grammar, errors } = elaborate(parsed.value);
    const [first, ...rest] = errors.toSorted(bySpan);
    return first ? { success: false, errors: [first, ...rest] } : { success: true, value: grammar };
  });
