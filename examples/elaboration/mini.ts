import { check, diagnostics, fail, get, pure, scoped, state, within, type Check } from "langkit/check";
import type { Analysis, Definition, Reference } from "langkit/analysis";
import type { Span } from "langkit/diagnostic";
import { createBindings } from "langkit/bindings";
import { createJudgments, type RuleTable, type Synthesized } from "langkit/judgments";
import { createCompiler } from "langkit/language";
import { createTrace, type TraceEvent } from "langkit/trace";
import * as rows from "langkit/types/rows";
import * as rank from "langkit/types/higher-rank";
import { program, type Annotation, type Expr } from "./syntax.ts";

export interface MiniFacts {
  readonly analysis: Analysis<string>;
  readonly trace: readonly TraceEvent<string, string>[];
}
export interface MiniPartial { readonly type: string; readonly term: string }
interface Handle<T> { readonly id: symbol; readonly name: string; readonly js: string; readonly type: T }
interface Theory<T, S> {
  readonly number: T;
  readonly boolean: T;
  readonly fresh: () => Check<T>;
  readonly fn: (param: T, result: T) => T;
  readonly record: (fields: ReadonlyMap<string, T>) => T;
  readonly field: (base: T, name: string) => Check<T>;
  readonly arrow: (type: T) => Check<{ readonly param: T; readonly result: T }>;
  readonly unify: (left: T, right: T) => Check<void>;
  readonly mono: (type: T) => S;
  readonly instantiate: (scheme: S) => Check<T>;
  readonly generalize: (type: T, outer: readonly S[]) => Check<S>;
  readonly annotation: (annotation: Annotation) => Check<T>;
  readonly enter: (expected: T, body: (opened: T) => Check<string>) => Check<string>;
  readonly subsume: (actual: T, expected: T) => Check<void>;
  readonly finalize: (type: T) => Check<void>;
  readonly show: (type: T) => string;
}

const hmAnnotation = (annotation: Annotation): Check<rows.Type> => check(function* () {
  if (annotation.kind === "forall") return yield* fail("HM mode does not permit forall annotations");
  if (annotation.kind === "function") return rows.fn(yield* hmAnnotation(annotation.param), yield* hmAnnotation(annotation.result));
  if (annotation.name === "number") return rows.number;
  if (annotation.name === "boolean") return rows.boolean;
  return yield* fail(`Unknown type: ${annotation.name}`);
});
const rankAnnotation = (annotation: Annotation, names: ReadonlyMap<string, rank.Generic> = new Map()): Check<rank.Type> => check(function* () {
  if (annotation.kind === "forall") {
    const variables = annotation.names.map(rank.generic);
    return rank.forall(variables, yield* rankAnnotation(annotation.body, new Map([...names, ...variables.map((variable) => [variable.name, variable] as const)])));
  }
  if (annotation.kind === "function") return rank.fn(yield* rankAnnotation(annotation.param, names), yield* rankAnnotation(annotation.result, names));
  if (annotation.name === "number") return rank.number;
  if (annotation.name === "boolean") return rank.boolean;
  const variable = names.get(annotation.name);
  return variable ?? (yield* fail(`Unknown type: ${annotation.name}`));
});
const hmTheory = (): Theory<rows.Type, rows.Scheme> => ({
  ...rows,
  record: (fields) => rows.record(rows.row(fields)),
  field: (base, name) => check(function* () {
    const type = yield* rows.fresh();
    yield* rows.unify(base, rows.record(rows.row(new Map([[name, type]]), yield* rows.freshRow([name]))));
    return type;
  }),
  arrow: (type) => check(function* () {
    const param = yield* rows.fresh(), result = yield* rows.fresh();
    yield* rows.unify(type, rows.fn(param, result));
    return { param, result };
  }),
  annotation: hmAnnotation,
  enter: (expected, body) => body(expected),
  subsume: rows.unify,
  finalize: (type) => rows.generalize(type, []).map(() => undefined),
});
const rankTheory = (): Theory<rank.Type, rank.Scheme> => {
  const level = scoped(0);
  const atLevel = <A>(body: (level: number) => Check<A>): Check<A> => get(level).flatMap(body);
  const noEscape = (input: rank.Type): Check<void> => check(function* () {
    const type = rank.prune(input);
    if (type.kind === "skolem") return yield* fail("Rigid type escaped finalization");
    if (type.kind === "function") { yield* noEscape(type.param); yield* noEscape(type.result); }
    if (type.kind === "record") for (const field of rank.flatten(type.row).fields.values()) yield* noEscape(field);
    if (type.kind === "forall") yield* noEscape(type.body);
  });
  return {
    ...rank,
    fresh: () => atLevel(rank.fresh),
    instantiate: (scheme) => atLevel((level) => rank.instantiate(scheme, level)),
    record: (fields) => rank.record(rank.row(fields)),
    field: (base, name) => atLevel((level) => check(function* () {
      const type = yield* rank.fresh(level);
      yield* rank.unify(base, rank.record(rank.row(new Map([[name, type]]), yield* rank.freshRow([name], level))));
      return type;
    })),
    arrow: (type) => atLevel((level) => rank.expectFunction(type, level)),
    annotation: rankAnnotation,
    enter: (expected, body) => atLevel((outer) => rank.prune(expected).kind === "forall"
      ? rank.withRigidScope(expected, outer, (opened, inner) => within(level, () => inner, body(opened)))
      : body(expected)),
    subsume: (actual, expected) => atLevel((level) => rank.subsume(actual, expected, level)),
    finalize: noEscape,
  };
};

const compilerFor = <T, S>(makeTheory: () => Theory<T, S>) => createCompiler({
  configure: (source: string) => {
    const theory = makeTheory();
    const trace = createTrace<T, string, string, string>(theory.show, (term) => term);
    const observed = state<{ definitions: Definition<T>[]; references: Reference[] }>(() => ({ definitions: [], references: [] }), (facts) => {
      const definitions = facts.definitions.length, references = facts.references.length;
      return () => { facts.definitions.length = definitions; facts.references.length = references; };
    });
    let next = 0;
    const handle = (name: string, type: T): Handle<T> => ({ id: Symbol(name), name, type, js: `$${next++}` });
    const bindings = createBindings<T, string, Handle<T>, S>({
      monomorphic: theory.mono,
      instantiate: theory.instantiate,
      generalize: theory.generalize,
      parameter: handle,
      declare: (name, value) => check(function* () { return handle(name, value.type); }),
      reference: (binding) => binding.js,
      define: (binding, type, span, kind) => get(observed).map((facts) => { facts.definitions.push({ id: binding.id, name: binding.name, type, span, kind }); }),
      use: (binding, _type, span) => get(observed).map((facts) => { facts.references.push({ id: binding.id, span }); }),
    });
    const constraint = (relation: string, operands: readonly T[], reason: string, body: Check<void>) => trace.constrain(relation, operands, reason, body);
    const rules: RuleTable<Expr, T, string> = {
      number: { mode: "synth", check: "fromSynth", *synth(n) { return { type: theory.number, term: String(n.value) }; } },
      boolean: { mode: "synth", check: "fromSynth", *synth(n) { return { type: theory.boolean, term: String(n.value) }; } },
      name: { mode: "synth", check: "fromSynth", *synth(n) { return yield* bindings.reference(n.name, n.span); } },
      hole: { mode: "synth", check: "fromSynth", *synth() {
        yield* fail("Unfilled expression hole").mapError((error) => ({ ...error, code: "mini.hole" })).recover();
        return { type: yield* theory.fresh(), term: "undefined" };
      } },
      fn: { mode: "synth", *synth(n, j) {
        const param = n.annotation ? yield* theory.annotation(n.annotation) : yield* theory.fresh();
        return yield* bindings.parameter(n.name, param, n.nameSpan, (binding) => check(function* () {
          const body = yield* j.synth(n.body);
          return { type: theory.fn(param, body.type), term: `((${binding.js})=>${body.term})` };
        }));
      }, *check(n, expected, j) {
        const arrow = yield* theory.arrow(expected);
        if (n.annotation) {
          const annotation = yield* theory.annotation(n.annotation);
          yield* constraint("equal", [annotation, arrow.param], "parameter annotation", theory.unify(annotation, arrow.param));
        }
        return yield* bindings.parameter(n.name, arrow.param, n.nameSpan, (binding) => j.check(n.body, arrow.result).map((body) => `((${binding.js})=>${body})`));
      } },
      let: { mode: "synth", check: "fromSynth", *synth(n, j) {
        return yield* bindings.let(n.name, n.nameSpan, j.synth(n.value), (binding, value) => j.synth(n.body).map((body) => ({ type: body.type, term: `(()=>{const ${binding.js}=${value.term};return ${body.term};})()` })));
      } },
      call: { mode: "synth", check: "fromSynth", *synth(n, j) {
        const callee = yield* j.synth(n.callee);
        const arrow = yield* trace.constrain("function", [callee.type], "application callee", theory.arrow(callee.type));
        const argument = yield* j.check(n.argument, arrow.param).recover(pure("undefined"));
        return { type: arrow.result, term: `${callee.term}(${argument})` };
      } },
      record: { mode: "synth", check: "fromSynth", *synth(n, j) {
        const fields = new Map<string, T>(), terms: string[] = [];
        for (const field of n.fields) {
          if (fields.has(field.name)) return yield* fail(`Duplicate field: ${field.name}`);
          const value = yield* j.synth(field.value);
          fields.set(field.name, value.type);
          terms.push(`[${JSON.stringify(field.name)}]:${value.term}`);
        }
        return { type: theory.record(fields), term: `({${terms.join(",")}})` };
      } },
      field: { mode: "synth", check: "fromSynth", *synth(n, j) {
        const base = yield* j.synth(n.base);
        const type = yield* trace.constrain("field", [base.type], `projection .${n.name}`, theory.field(base.type, n.name));
        return { type, term: `${base.term}[${JSON.stringify(n.name)}]` };
      } },
      annotation: { mode: "synth", check: "fromSynth", *synth(n, j) {
        const type = yield* theory.annotation(n.annotation);
        const term = yield* j.check(n.value, type);
        return { type, term };
      } },
    };
    const j = createJudgments(rules, {
      trace,
      source: (node) => ({ span: node.span, document: "memory:mini" }),
      modes: { enter: theory.enter, accept: (actual, expected) => constraint("subsume", [actual.type, expected], "checking synthesized expression", theory.subsume(actual.type, expected)).map(() => actual.term) },
    });
    return {
      elaborate: check(function* () {
        const parsed = program.parse(source);
        if (!parsed.success) return yield* fail(parsed.error.message).at(parsed.error.diagnostic.span).mapError((error) => ({ ...error, code: "mini.parse" }));
        return yield* j.synth(parsed.value);
      }).inDocument("memory:mini"),
      finalize: (value: Synthesized<T, string>) => theory.finalize(value.type).map(() => value.term),
      snapshot: (value: Synthesized<T, string>): MiniPartial => ({ type: theory.show(value.type), term: value.term }),
      facts: check(function* (): Generator<Check<unknown>, MiniFacts, unknown> {
        const facts = yield* get(observed);
        const events = yield* trace.snapshot();
        const invocations = new Map(events.filter((event) => event.span).map((event) => [event.id, event]));
        const types = events.flatMap((event) => {
          const span = invocations.get(event.id)?.span;
          const type = event.synthesized ?? event.checked;
          return span && type !== undefined ? [{ type, span }] : [];
        });
        const definitions = facts.definitions.map(({ type, ...definition }) => ({ ...definition, ...(type === undefined ? {} : { type: theory.show(type) }) }));
        for (const definition of definitions) if (definition.type !== undefined) types.push({ type: definition.type, span: definition.span });
        return { analysis: { diagnostics: yield* diagnostics(), types, definitions, references: [...facts.references], tokens: [] }, trace: events };
      }),
    };
  },
  emit: (term: string) => term,
});

export const hm = compilerFor(hmTheory);
export const higherRank = compilerFor(rankTheory);
