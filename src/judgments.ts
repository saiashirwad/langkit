import { check, fail, get, pure, scoped, within, type Check } from "./check.ts";
import type { Span } from "./diagnostic.ts";
import type { TraceRecorder } from "./trace.ts";

export interface Synthesized<Type, Term> { readonly type: Type; readonly term: Term }
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
  | { readonly mode: "synth"; readonly synth: (node: N, judgments: Judgments<All, T, E>) => RuleBody<Synthesized<T, E>>; readonly check: "fromSynth" | ((node: N, expected: T, judgments: Judgments<All, T, E>) => RuleBody<E>) }
  | { readonly mode: "checkingOnly"; readonly check: (node: N, expected: T, judgments: Judgments<All, T, E>) => RuleBody<E> }
  | { readonly mode: "unsupported"; readonly reason: string };
export type RuleTable<N extends { readonly kind: string }, T, E> = {
  readonly [K in N["kind"]]: Rule<Extract<N, { readonly kind: K }>, N, T, E>;
};
export interface JudgmentOptions<N, T, E> {
  readonly modes: CheckingModes<T, E>;
  readonly source?: (node: N) => { readonly span?: Span; readonly document?: string };
  readonly trace?: TraceRecorder<T, E>;
  readonly typed?: (type: T, span: Span) => Check<void>;
}
export const createJudgments = <N extends { readonly kind: string }, T, E>(rules: RuleTable<N, T, E>, options: JudgmentOptions<N, T, E>): Judgments<N, T, E> => {
  const selectedRules = new Map<string, Rule<N, N, T, E>>();
  for (const kind of Object.keys(rules)) selectedRules.set(kind, { ...rules[kind as N["kind"]] } as Rule<N, N, T, E>);
  const current = scoped<symbol | undefined>(undefined);
  const locate = <A>(node: N, phase: "synth" | "check", expected: T | undefined, body: Check<A>, observe?: (id: symbol, value: A) => Check<void>): Check<A> => {
    const source = options.source?.(node);
    const rule = `${node.kind}.${phase}`;
    const attributed = check(function* () {
      const parent = yield* get(current);
      const invoke = (id: symbol) => within(current, () => id,
        body.flatMap((value) => observe && options.trace ? observe(id, value).map(() => value) : pure(value)).withDiagnostics((error) => ({
          ...error,
          code: error.code ?? "judgment.failed",
          ...(error.invocation === undefined ? { invocation: id, rule, ...(parent === undefined ? {} : { parentInvocation: parent }) } : {}),
        })),
      );
      return yield* (options.trace
        ? options.trace.invocation({ rule, phase, ...source, ...(expected === undefined ? {} : { expected }) }, invoke)
        : invoke(Symbol(rule)));
    });
    const located = attributed.at(source?.span);
    return source?.document === undefined ? located : located.inDocument(source.document);
  };
  const select = (node: N): Rule<N, N, T, E> => selectedRules.get(node.kind)!;
  const judgments: Judgments<N, T, E> = {
    synth: (node) => locate(node, "synth", undefined, check(function* () {
      const rule = select(node);
      if (rule.mode !== "synth") return yield* fail(rule.mode === "unsupported" ? rule.reason : `${node.kind} requires an expected type`).mapError((error) => ({ ...error, code: "judgment.synthesis-unavailable" }));
      const result = yield* check(() => rule.synth(node, judgments));
      const span = options.source?.(node).span;
      if (span && options.typed) yield* options.typed(result.type, span);
      return result;
    }), (id, value) => options.trace!.result(id, value.type, value.term)),
    check: (node, expected) => locate(node, "check", expected, options.modes.enter(expected, (opened) => check(function* () {
      const rule = select(node);
      if (rule.mode === "unsupported") return yield* fail(rule.reason).mapError((error) => ({ ...error, code: "judgment.unsupported" }));
      if (rule.check === "fromSynth") return yield* options.modes.accept(yield* judgments.synth(node), opened);
      const specialized = rule.check;
      return yield* check(() => specialized(node, opened, judgments));
    })), (id, term) => options.trace!.checkedResult(id, expected, term)),
  };
  return judgments;
};
