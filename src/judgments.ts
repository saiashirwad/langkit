import { type Check, check, fail } from "./check.ts";
import type { Span } from "./diagnostic.ts";

export interface Synthesized<Type, Term> {
  readonly type: Type;
  readonly term: Term;
}
export interface Judgments<Node, Type, Term> {
  synth(node: Node): Check<Synthesized<Type, Term>>;
  check(node: Node, expected: Type): Check<Term>;
}
export interface CheckingModes<Type, Term> {
  enter(expected: Type, body: (opened: Type) => Check<Term>): Check<Term>;
  accept(actual: Synthesized<Type, Term>, expected: Type): Check<Term>;
}
export type RuleBody<A> = Generator<Check<unknown>, A, unknown>;
export type Rule<N, All, T, E> =
  | {
    readonly mode: "synth";
    readonly synth: (node: N, judgments: Judgments<All, T, E>) => RuleBody<Synthesized<T, E>>;
    readonly check: "fromSynth" | ((node: N, expected: T, judgments: Judgments<All, T, E>) => RuleBody<E>);
  }
  | {
    readonly mode: "checkingOnly";
    readonly check: (node: N, expected: T, judgments: Judgments<All, T, E>) => RuleBody<E>;
  }
  | { readonly mode: "unsupported"; readonly reason: string; };
export type RuleTable<N extends { readonly kind: string; }, T, E> = {
  readonly [K in N["kind"]]: Rule<Extract<N, { readonly kind: K; }>, N, T, E>;
};
export interface JudgmentOptions<N, T, E> {
  readonly modes: CheckingModes<T, E>;
  readonly span?: (node: N) => Span;
  readonly typed?: (type: T, span: Span) => Check<void>;
}
export const createJudgments = <N extends { readonly kind: string; }, T, E>(
  rules: RuleTable<N, T, E>,
  options: JudgmentOptions<N, T, E>,
): Judgments<N, T, E> => {
  const select = (node: N) => rules[node.kind as N["kind"]] as Rule<N, N, T, E>;
  const judgments: Judgments<N, T, E> = {
    synth: (node) => {
      const span = options.span?.(node);
      return check(function*() {
        const rule = select(node);
        if (rule.mode !== "synth") {
          return yield* fail(rule.mode === "unsupported" ? rule.reason : `${node.kind} requires an expected type`);
        }
        const result = yield* check(() => rule.synth(node, judgments));
        if (span && options.typed) yield* options.typed(result.type, span);
        return result;
      }).at(span);
    },
    check: (node, expected) =>
      options.modes.enter(expected, (opened) =>
        check(function*() {
          const rule = select(node);
          if (rule.mode === "unsupported") return yield* fail(rule.reason);
          if (rule.check === "fromSynth") return yield* options.modes.accept(yield* judgments.synth(node), opened);
          const specialized = rule.check;
          return yield* check(() => specialized(node, opened, judgments));
        })).at(options.span?.(node)),
  };
  return judgments;
};
