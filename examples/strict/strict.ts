import {
  bind,
  check,
  fail,
  get,
  lookup,
  render,
  run,
  scoped,
  within,
  type Check,
  type Result,
  type Span,
} from "langkit";
import { create, type Binding, type Body, type Value } from "langkit/ir";
import { create as createAnalysis, highlight, type Analysis } from "langkit/analysis";
import { emit } from "langkit/javascript";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { loadModules, type ModuleOptions, type ModuleSource } from "../modules.ts";
import { runInNewContext } from "node:vm";
import {
  program,
  tokens,
  type DataDecl,
  type ClassDecl,
  type InstanceDecl,
  type KindExpr,
  type Expr,
  type Module,
  type TypeExpr,
} from "./strict-syntax.ts";
import {
  number,
  boolean,
  string,
  fn,
  record,
  row,
  fresh,
  freshRow,
  prune,
  flatten,
  exclude,
  unify,
  free,
  mono,
  generalize,
  instantiate,
  instantiateForall,
  skolemize,
  generic,
  forall,
  data,
  subsume,
  substitute,
  constructorType,
  apply,
  decompose,
  qualified,
  sameType,
  typeKind,
  kindArrow,
  freshKind,
  kindOf,
  unifyKinds,
  defaultKind,
  type Type,
  type Scheme,
  type TypeConstructor,
  type Generic,
  type Kind,
  type Predicate,
} from "./strict-types.ts";

export { program } from "./strict-syntax.ts";
export { show, type Type } from "./strict-types.ts";
export type { Expr } from "./strict-syntax.ts";
import { show } from "./strict-types.ts";

type Entry = {
  readonly binding: Binding<Type>;
  readonly scheme: Scheme;
  readonly identity?: symbol;
};

type Constructor = {
  readonly binding: Binding<Type>;
  readonly type: Type;
  readonly arity: number;
  readonly tag: string;
  readonly owner: TypeConstructor;
};

type Definition = { readonly type: TypeConstructor; readonly constructors: readonly string[] };

const code = create<Type>();
const facts = createAnalysis<Type>();
const env = scoped<ReadonlyMap<string, Entry>>(new Map());
const definitions = scoped<ReadonlyMap<string, Definition>>(new Map());
const constructors = scoped<ReadonlyMap<string, Constructor>>(new Map());
const level = scoped(0);
const observe = scoped(true);

type Origin = {
  readonly id: symbol;
  readonly name: string;
  readonly type: Type;
  readonly span: Span;
  readonly kind: "variable" | "parameter" | "function";
  readonly uri: string;
};

const currentModule = scoped("");
const origins = scoped<Map<symbol, Origin>>(new Map());

const define = (
  binding: Binding<Type>,
  span: Span,
  kind: Origin["kind"] = "variable",
): Check<void> =>
  check(function* () {
    (yield* get(origins)).set(binding.id, {
      ...binding,
      span,
      kind,
      uri: yield* get(currentModule),
    });
    if (yield* get(observe)) yield* facts.define(binding, span, kind);
  });

type Class = { readonly parameter: Generic; readonly methods: ReadonlyMap<string, Type> };

type Evidence = {
  readonly predicate: Predicate;
  readonly value: Value<Type>;
  readonly identity?: symbol;
};

type Wanted = {
  readonly predicate: Predicate;
  readonly binding: Binding<Type>;
  readonly givens: readonly Evidence[];
  readonly instances: readonly Evidence[];
  readonly span: Span;
};

const classes = scoped<ReadonlyMap<string, Class>>(new Map());
const instances = scoped<readonly Evidence[]>([]);
const givens = scoped<readonly Evidence[]>([]);
const wanted = scoped<Wanted[]>([]);
const solutions = scoped<Map<symbol, Value<Type>>>(new Map());
const effectConstructor: TypeConstructor = { id: Symbol("Effect"), name: "Effect", arity: 1 };

const effect = (type: Type) => data(effectConstructor, [type]);

const kind = (syntax: KindExpr): Kind =>
  syntax.kind === "type" ? typeKind : kindArrow(kind(syntax.param), kind(syntax.result));

// Application is kind-checked before a source type may enter unification.
const resolve = (
  syntax: TypeExpr,
  parameters: ReadonlyMap<string, Type> = new Map(),
): Check<Type> =>
  check(function* () {
    switch (syntax.kind) {
      case "name": {
        const primitive =
          syntax.name === "number"
            ? number
            : syntax.name === "boolean"
              ? boolean
              : syntax.name === "string"
                ? string
                : undefined;
        const definition = (yield* get(definitions)).get(syntax.name);
        let type =
          parameters.get(syntax.name) ??
          primitive ??
          (definition ? constructorType(definition.type) : undefined);
        if (!type) return yield* fail(`Unknown type: ${syntax.name}`);
        for (const argument of syntax.args) {
          const arg = yield* resolve(argument, parameters);
          if (["forall", "qualified"].includes(prune(arg).kind))
            return yield* fail("Polymorphic type arguments are not supported");
          type = yield* apply(type, arg);
        }
        return type;
      }
      case "function": {
        const param = yield* resolveValueType(syntax.param, parameters);
        const result = yield* resolveValueType(syntax.result, parameters);
        if (containsConstraints(param) || containsConstraints(result))
          return yield* fail(
            "Constraints belong at the outside of a signature, not under an arrow",
          );
        return fn(param, result);
      }
      case "record": {
        const fields = new Map<string, Type>();
        for (const field of syntax.fields) {
          if (fields.has(field.name)) return yield* fail(`Duplicate field: ${field.name}`);
          const type = yield* resolveValueType(field.type, parameters);
          if (["forall", "qualified"].includes(prune(type).kind))
            return yield* fail("Polymorphic record fields are not supported");
          fields.set(field.name, type);
        }
        return record(row(fields));
      }
      case "forall": {
        if (new Set(syntax.parameters).size !== syntax.parameters.length)
          return yield* fail("Duplicate forall parameter");
        const variables = syntax.parameters.map((name) => generic(name, freshKind()));
        const nested = new Map(parameters);
        for (const variable of variables) nested.set(variable.name, variable);
        const body = yield* resolveValueType(syntax.body, nested);
        for (const variable of variables) defaultKind(kindOf(variable));
        return forall(variables, body);
      }
      case "qualified": {
        const predicates: Predicate[] = [];
        const known = yield* get(classes);
        for (const predicate of syntax.predicates) {
          const definition = known.get(predicate.className);
          if (!definition)
            return yield* fail(`Unknown class: ${predicate.className}`).at(predicate.span);
          const arg = yield* resolve(predicate.arg, parameters);
          yield* unifyKinds(kindOf(arg), kindOf(definition.parameter)).at(predicate.span);
          predicates.push({ className: predicate.className, arg });
        }
        const type = yield* resolveValueType(syntax.type, parameters);
        for (const parameter of parameters.values()) {
          if (parameter.kind !== "generic") continue;
          const witness = fresh(0, kindOf(parameter));
          const replacement = new Map([[parameter, witness]]);
          if (
            predicates.some((predicate) =>
              free(substitute(predicate.arg, replacement)).has(witness),
            ) &&
            !free(substitute(type, replacement)).has(witness)
          )
            return yield* fail(`Ambiguous constraint variable: ${parameter.name}`);
        }
        return qualified(predicates, type);
      }
    }
  }).at(syntax.span);

const resolveValueType = (
  syntax: TypeExpr,
  parameters: ReadonlyMap<string, Type> = new Map(),
): Check<Type> =>
  check(function* () {
    const type = yield* resolve(syntax, parameters);
    yield* unifyKinds(kindOf(type), typeKind);
    return type;
  }).at(syntax.span);

const containsConstraints = (input: Type): boolean => {
  const type = prune(input);
  return type.kind === "qualified" || (type.kind === "forall" && containsConstraints(type.body));
};

const dictionaryType = (predicate: Predicate): Check<Type> =>
  check(function* () {
    const definition = yield* lookup(classes, predicate.className);
    return record(
      row(
        new Map(
          [...definition.methods].map(([name, type]) => [
            name,
            substitute(type, new Map([[definition.parameter, predicate.arg]])),
          ]),
        ),
      ),
    );
  });

const evidence = (want: Wanted): Value<Type> | undefined =>
  [...want.givens, ...want.instances].find(
    (candidate) =>
      candidate.predicate.className === want.predicate.className &&
      sameType(candidate.predicate.arg, want.predicate.arg),
  )?.value;

const demand = (predicate: Predicate, span: Span): Check<Value<Type>> =>
  check(function* () {
    const binding = code.binding("dictionary", yield* dictionaryType(predicate));
    (yield* get(wanted)).push({
      predicate,
      binding,
      givens: yield* get(givens),
      instances: yield* get(instances),
      span,
    });
    return code.ref(binding);
  });

const useValue = (value: Value<Type>, span: Span): Check<Value<Type>> =>
  check(function* () {
    let type = instantiateForall(value.type, yield* get(level));
    let result = { ...value, type };
    while (type.kind === "qualified") {
      for (const predicate of type.predicates)
        result = code.call(type.type, result, yield* demand(predicate, span));
      type = instantiateForall(type.type, yield* get(level));
      result = { ...result, type };
    }
    return result;
  });

const discharge = (wants: readonly Wanted[]): Check<Wanted[]> =>
  check(function* () {
    const remaining: Wanted[] = [];
    const solved = yield* get(solutions);
    for (const want of wants) {
      const value = evidence(want);
      if (value) solved.set(want.binding.id, value);
      else remaining.push(want);
    }
    return remaining;
  });

const requireEvidence = (wants: readonly Wanted[]): Check<void> =>
  check(function* () {
    const remaining = yield* discharge(wants);
    if (remaining.length) {
      const want = remaining[0]!;
      return yield* fail(
        `No instance or ambiguous constraint: ${want.predicate.className} ${show(want.predicate.arg)}`,
      ).at(want.span);
    }
  });

const typed = (expr: Expr, computation: Check<Value<Type>>): Check<Value<Type>> =>
  computation
    .flatMap((value) =>
      check(function* () {
        if (yield* get(observe)) yield* facts.typed(value.type, expr.span);
        return code.at(value, expr.span);
      }),
    )
    .at(expr.span);

// Checking uses expected types to introduce rigid quantifiers and check lambdas.
// Inference never guesses a forall for a lambda parameter.
const checkExpr = (expr: Expr, expected: Type): Check<Value<Type>> =>
  typed(
    expr,
    check(function* () {
      const target = prune(expected);
      const current = yield* get(level);
      if (target.kind === "forall") {
        const value = yield* within(
          level,
          current + 1,
          checkExpr(expr, skolemize(target, current + 1)),
        );
        return { ...value, type: expected };
      }
      if (target.kind === "qualified") {
        if (expr.kind !== "fn" && expr.kind !== "name")
          return yield* fail("Constrained values must be functions or aliases; add a parameter");
        const entries: Evidence[] = [];
        const parameters: Binding<Type>[] = [];
        for (const predicate of target.predicates) {
          const binding = code.binding("dictionary", yield* dictionaryType(predicate));
          parameters.push(binding);
          entries.push({ predicate, value: code.ref(binding) });
        }
        const local: Wanted[] = [];
        let body = yield* code.body(
          within(
            givens,
            [...(yield* get(givens)), ...entries],
            within(wanted, local, checkExpr(expr, target.type)),
          ),
        );
        yield* requireEvidence(local);
        for (const parameter of parameters.toReversed()) {
          body = { declarations: [], result: code.fn(expected, parameter, body) };
        }
        return body.result;
      }
      if (expr.kind === "fn" && target.kind === "function") {
        const parameter = expr.annotation ? yield* resolveValueType(expr.annotation) : target.param;
        if (containsConstraints(parameter))
          return yield* fail("Constrained lambda parameters are not supported");
        if (expr.annotation) yield* subsume(target.param, parameter, current);
        const binding = code.binding(expr.param, parameter);
        yield* define(binding, expr.paramSpan, "parameter");
        const body = yield* code.body(
          bind(
            env,
            [[expr.param, { binding, scheme: mono(parameter) }]],
            checkExpr(expr.body, target.result),
          ),
        );
        return code.fn(expected, binding, body);
      }
      if (expr.kind === "if") {
        const cond = yield* checkExpr(expr.cond, boolean);
        const then = yield* code.body(checkExpr(expr.then, expected));
        const otherwise = yield* code.body(checkExpr(expr.else, expected));
        return code.conditional(expected, cond, then, otherwise);
      }
      if (expr.kind === "let") return yield* elaborateLet(expr, expected);
      if (expr.kind === "match") return yield* elaborateMatch(expr, expected);
      const value = yield* useValue(yield* elaborate(expr), expr.span);
      yield* subsume(value.type, expected, current);
      return { ...value, type: expected };
    }),
  );

const elaborateLet = (
  expr: Extract<Expr, { kind: "let" }>,
  expected?: Type,
  continuation?: Check<Value<Type>>,
): Check<Value<Type>> =>
  code.scope(
    check(function* () {
      const environment = yield* get(env);
      const schemes = [...environment.values()].map((entry) => entry.scheme);
      const annotation = expr.annotation ? yield* resolveValueType(expr.annotation) : undefined;
      const local: Wanted[] = [];
      let recursiveBinding: Binding<Type> | undefined;
      let computation: Check<Value<Type>>;
      if (expr.recursive) {
        if (expr.value.kind !== "fn")
          return yield* fail("Recursive bindings require a function initializer");
        const type = annotation ?? fresh(yield* get(level));
        recursiveBinding = code.binding(expr.name, type);
        computation = bind(
          env,
          [[expr.name, { binding: recursiveBinding, scheme: mono(type) }]],
          checkExpr(expr.value, type),
        );
      } else computation = annotation ? checkExpr(expr.value, annotation) : elaborate(expr.value);
      let built = yield* code.body(within(wanted, local, computation));
      let initial = built.declarations.length
        ? { type: built.result.type, node: { kind: "block" as const, body: built } }
        : built.result;
      let scheme: Scheme;
      if (annotation) {
        yield* requireEvidence(local);
        scheme = mono(annotation);
      } else {
        const remaining = yield* discharge(local);
        const candidate = generalize(initial.type, schemes);
        const variables = new Set(candidate.variables);
        const resultVariables = free(initial.type);
        const abstract: { predicate: Predicate; binding: Binding<Type> }[] = [];
        const solved = yield* get(solutions);
        const outer = yield* get(wanted);
        // Constraints involving captured variables stay in the enclosing scope.
        // They also prevent connected variables from being generalized here.
        for (const want of remaining) {
          const localVariables = generalize(want.predicate.arg, schemes).variables;
          if ([...localVariables].some((variable) => !resultVariables.has(variable)))
            return yield* fail(
              `Ambiguous constraint: ${want.predicate.className} ${show(want.predicate.arg)}`,
            ).at(want.span);
          const needed = free(want.predicate.arg);
          if (![...needed].every((variable) => candidate.variables.has(variable)))
            for (const variable of needed) variables.delete(variable);
        }
        let changed = true;
        while (changed) {
          const before = variables.size;
          for (const want of remaining) {
            const needed = free(want.predicate.arg);
            if (![...needed].every((variable) => variables.has(variable)))
              for (const variable of needed) variables.delete(variable);
          }
          changed = variables.size !== before;
        }
        for (const want of remaining) {
          const needed = free(want.predicate.arg);
          if (!needed.size)
            return yield* fail(
              `No instance: ${want.predicate.className} ${show(want.predicate.arg)}`,
            ).at(want.span);
          if ([...needed].every((variable) => variables.has(variable))) {
            if (expr.recursive)
              return yield* fail(
                "Recursive overloaded functions need an explicit constrained signature",
              );
            if (expr.value.kind !== "fn" && expr.value.kind !== "name")
              return yield* fail(
                "Constrained values must be functions or aliases; add a parameter",
              );
            let entry = abstract.find(
              (entry) =>
                entry.predicate.className === want.predicate.className &&
                sameType(entry.predicate.arg, want.predicate.arg),
            );
            if (!entry) {
              entry = {
                predicate: want.predicate,
                binding: code.binding("dictionary", yield* dictionaryType(want.predicate)),
              };
              abstract.push(entry);
            }
            solved.set(want.binding.id, code.ref(entry.binding));
          } else outer.push(want);
        }
        const type = qualified(
          abstract.map((entry) => entry.predicate),
          initial.type,
        );
        for (const entry of abstract.toReversed()) {
          initial = code.fn(type, entry.binding, built);
          built = { declarations: [], result: initial };
        }
        scheme = { type, variables };
      }
      const value = recursiveBinding
        ? yield* code.declareRecursive(recursiveBinding, initial)
        : yield* code.declare(expr.name, initial);
      const binding = value.node.binding;
      yield* define(
        { ...binding, type: scheme.type },
        expr.nameSpan,
        ["function", "forall", "qualified"].includes(prune(scheme.type).kind)
          ? "function"
          : "variable",
      );
      return yield* bind(
        env,
        [[expr.name, { binding, scheme }]],
        continuation ?? (expected ? checkExpr(expr.body, expected) : elaborate(expr.body)),
      );
    }),
  );

const elaborateMatch = (
  expr: Extract<Expr, { kind: "match" }>,
  expected?: Type,
): Check<Value<Type>> =>
  check(function* () {
    const value = yield* elaborate(expr.value);
    const current = yield* get(level);
    const result = expected ?? fresh(current);
    const known = yield* get(constructors);
    const seen = new Set<string>();
    const cases: { tag: string; bindings: Binding<Type>[]; body: Body<Type> }[] = [];
    let fallback: { binding?: Binding<Type>; body: Body<Type> } | undefined;
    if (!expr.cases.length) return yield* fail("Match requires at least one case");
    for (const branch of expr.cases) {
      if (fallback) return yield* fail("Unreachable case after catch-all").at(branch.span);
      const pattern = branch.pattern;
      if (pattern.kind === "binding") {
        if (pattern.name === "_")
          fallback = { body: yield* code.body(checkExpr(branch.body, result)) };
        else {
          const binding = code.binding(pattern.name, value.type);
          yield* define(binding, pattern.span);
          const body = yield* code.body(
            bind(
              env,
              [[pattern.name, { binding, scheme: mono(value.type) }]],
              checkExpr(branch.body, result),
            ),
          );
          fallback = { binding, body };
        }
        continue;
      }
      const constructor = known.get(pattern.name);
      if (!constructor) return yield* fail(`Unknown constructor: ${pattern.name}`).at(pattern.span);
      if (seen.has(constructor.tag))
        return yield* fail(`Unreachable duplicate case: ${pattern.name}`).at(pattern.span);
      seen.add(constructor.tag);
      if (pattern.fields.length !== constructor.arity)
        return yield* fail(
          `Constructor ${pattern.name} expects ${constructor.arity} fields, found ${pattern.fields.length}`,
        ).at(pattern.span);
      if (yield* get(observe))
        yield* facts.reference(constructor.binding, {
          start: pattern.span.start,
          end: pattern.span.start + pattern.name.length,
        });
      let type = instantiateForall(constructor.type, current);
      const bindings: Binding<Type>[] = [];
      const entries = new Map<string, Entry>();
      for (const field of pattern.fields) {
        const arrow = prune(type);
        if (arrow.kind !== "function") throw new Error("Constructor arity does not match its type");
        const binding = code.binding(field.name, arrow.param);
        bindings.push(binding);
        if (field.name !== "_") {
          if (entries.has(field.name))
            return yield* fail(`Duplicate pattern binding: ${field.name}`).at(field.span);
          entries.set(field.name, { binding, scheme: mono(arrow.param) });
          yield* define(binding, field.span);
        }
        type = arrow.result;
      }
      yield* unify(value.type, type).at(pattern.span);
      const body = yield* code.body(bind(env, entries, checkExpr(branch.body, result)));
      cases.push({ tag: constructor.tag, bindings, body });
    }
    if (!fallback) {
      const { head } = decompose(value.type);
      if (head.kind !== "constructor") return yield* fail("Constructor match requires a data type");
      const definition = [...(yield* get(definitions)).values()].find(
        (def) => def.type.id === head.constructor.id,
      )!;
      const missing = definition.constructors.filter((name) => !seen.has(known.get(name)!.tag));
      if (missing.length)
        return yield* fail(`Non-exhaustive match; missing: ${missing.join(", ")}`);
    }
    return code.match(result, value, cases, fallback);
  }).at(expr.span);

// The same constructor and dictionary flow through every step. In particular,
// lexical bindings named 'bind' cannot change the meaning of do notation.
const elaborateDo = (
  expr: Extract<Expr, { kind: "do" }>,
  monad?: Type,
  dictionary?: Value<Type>,
): Check<Value<Type>> =>
  check(function* () {
    const [step, ...rest] = expr.steps;
    if (!step) return yield* fail("Do requires a final monadic action");
    const current = yield* get(level);
    const constructor = monad ?? fresh(current, kindArrow(typeKind, typeKind));
    const definition = yield* lookup(classes, "Monad");
    yield* unifyKinds(kindOf(constructor), kindOf(definition.parameter));
    const declaredBind = definition.methods.get("bind");
    if (!declaredBind) return yield* fail("Monad must define bind for do notation");
    const evidence =
      dictionary ?? (yield* demand({ className: "Monad", arg: constructor }, expr.span));
    if (step.kind === "let") {
      if (!rest.length) return yield* fail("Do must end with a monadic action").at(step.span);
      const continuation: Expr = { kind: "do", steps: rest, span: expr.span };
      return yield* elaborateLet(
        {
          kind: "let",
          name: step.name,
          nameSpan: step.nameSpan,
          annotation: undefined,
          recursive: false,
          value: step.value,
          body: continuation,
          span: step.span,
        },
        undefined,
        elaborateDo(continuation, constructor, evidence),
      );
    }
    const result = fresh(current);
    const action = yield* checkExpr(step.value, yield* apply(constructor, result));
    if (!rest.length) {
      if (step.kind === "bind")
        return yield* fail("Do must end with a monadic action").at(step.span);
      return action;
    }
    const binding = code.binding(step.kind === "bind" ? step.name : "ignored", result);
    const continuation: Expr = { kind: "do", steps: rest, span: expr.span };
    if (step.kind === "bind") yield* define(binding, step.nameSpan);
    const body = yield* code.body(
      step.kind === "bind" && step.name !== "_"
        ? bind(
            env,
            [[step.name, { binding, scheme: mono(result) }]],
            elaborateDo(continuation, constructor, evidence),
          )
        : elaborateDo(continuation, constructor, evidence),
    );
    const callback = code.fn(fn(result, body.result.type), binding, body);
    const required = fn(action.type, fn(callback.type, body.result.type));
    const declared = substitute(declaredBind, new Map([[definition.parameter, constructor]]));
    // Monad is source-defined, not an intrinsic signature. Check the projection
    // against that declaration before assigning it the bind type needed here.
    yield* subsume(declared, required, current);
    const method = code.field(required, evidence, "bind");
    const partial = code.call(fn(callback.type, body.result.type), method, action);
    return code.call(body.result.type, partial, callback);
  }).at(expr.span);

export const elaborate = (expr: Expr): Check<Value<Type>> =>
  typed(
    expr,
    check(function* () {
      const current = yield* get(level);
      switch (expr.kind) {
        case "number":
          if (!Number.isFinite(expr.value)) return yield* fail("Number literal is too large");
          return code.literal(number, expr.value);
        case "boolean":
          return code.literal(boolean, expr.value);
        case "string":
          return code.literal(string, expr.value);
        case "name": {
          const { binding, scheme } = yield* lookup(env, expr.name);
          if (yield* get(observe)) yield* facts.reference(binding, expr.span);
          return yield* useValue(code.ref(binding, instantiate(scheme, current)), expr.span);
        }
        case "record": {
          const fields: { name: string; value: Value<Type> }[] = [];
          const types = new Map<string, Type>();
          for (const field of expr.fields) {
            if (types.has(field.name)) return yield* fail(`Duplicate field: ${field.name}`);
            const value = yield* elaborate(field.value);
            if (prune(value.type).kind === "forall")
              return yield* fail("Polymorphic record fields are not supported");
            fields.push({ name: field.name, value });
            types.set(field.name, value.type);
          }
          if (!expr.base) return code.record(record(row(types)), fields);
          const base = yield* elaborate(expr.base);
          const tail = freshRow([], current);
          yield* unify(base.type, record(row(new Map(), tail))).at(expr.base.span);
          yield* exclude(row(new Map(), tail), types.keys()).at(expr.base.span);
          return code.record(record(row(types, tail)), fields, base);
        }
        case "field": {
          const value = yield* elaborate(expr.record);
          const type = fresh(current);
          yield* unify(
            value.type,
            record(row(new Map([[expr.name, type]]), freshRow([expr.name], current))),
          );
          return code.field(type, value, expr.name);
        }
        case "binary": {
          const left = yield* checkExpr(expr.left, number);
          const right = yield* checkExpr(expr.right, number);
          return code.binary(
            expr.op === ">" || expr.op === "==" ? boolean : number,
            expr.op,
            left,
            right,
          );
        }
        case "let":
          return yield* elaborateLet(expr);
        case "fn": {
          const type = expr.annotation ? yield* resolveValueType(expr.annotation) : fresh(current);
          if (containsConstraints(type))
            return yield* fail("Constrained lambda parameters are not supported");
          const binding = code.binding(expr.param, type);
          yield* define(binding, expr.paramSpan, "parameter");
          const body = yield* code.body(
            bind(env, [[expr.param, { binding, scheme: mono(type) }]], elaborate(expr.body)),
          );
          if (containsConstraints(body.result.type))
            return yield* fail(
              "Constraints belong at the outside of a signature, not under an arrow",
            ).at(expr.body.span);
          return code.fn(fn(type, body.result.type), binding, body);
        }
        case "call": {
          const callee = yield* useValue(yield* elaborate(expr.fn), expr.fn.span);
          let type = prune(instantiateForall(callee.type, current));
          if (type.kind !== "function") {
            const param = fresh(current);
            const result = fresh(current);
            yield* unify(type, fn(param, result)).at(expr.fn.span);
            type = fn(param, result);
          }
          // The expected parameter type reaches the argument before its inference,
          // which is what makes explicitly higher-rank arguments checkable.
          if (type.kind !== "function") throw new Error("Expected function after unification");
          const arg = yield* checkExpr(expr.arg, type.param);
          return code.call(type.result, callee, arg);
        }
        case "if": {
          const cond = yield* checkExpr(expr.cond, boolean);
          const then = yield* code.body(elaborate(expr.then));
          const otherwise = yield* code.body(checkExpr(expr.else, then.result.type));
          return code.conditional(then.result.type, cond, then, otherwise);
        }
        case "annotated":
          return yield* checkExpr(expr.value, yield* resolveValueType(expr.annotation));
        case "match":
          return yield* elaborateMatch(expr);
        case "do":
          return yield* elaborateDo(expr);
      }
    }),
  );

// Datatypes are nominal. Register all names before resolving constructor fields,
// allowing recursive and mutually recursive declarations without type aliases.
const withTypes = <A>(declarations: readonly DataDecl[], body: Check<A>): Check<A> =>
  check(function* () {
    const existing = yield* get(definitions);
    const added = new Map<string, Definition>();
    for (const declaration of declarations) {
      if (
        existing.has(declaration.name) ||
        added.has(declaration.name) ||
        ["number", "boolean", "string"].includes(declaration.name)
      )
        return yield* fail(`Duplicate type: ${declaration.name}`).at(declaration.nameSpan);
      if (new Set(declaration.parameters).size !== declaration.parameters.length)
        return yield* fail(`Duplicate type parameter in ${declaration.name}`).at(declaration.span);
      if (!declaration.constructors.length)
        return yield* fail("Data type requires a constructor").at(declaration.span);
      added.set(declaration.name, {
        type: {
          id: Symbol(declaration.name),
          name: declaration.name,
          arity: declaration.parameters.length,
          parameters: declaration.parameters.map(() => freshKind()),
        },
        constructors: declaration.constructors.map((constructor) => constructor.name),
      });
    }
    return yield* bind(
      definitions,
      added,
      check(function* () {
        const known = yield* get(constructors);
        const addedConstructors = new Map<string, Constructor>();
        const entries = new Map<string, Entry>();
        for (const declaration of declarations) {
          const owner = added.get(declaration.name)!.type;
          const variables = declaration.parameters.map((name, index) =>
            generic(name, owner.parameters![index]!),
          );
          const parameters = new Map<string, Type>(
            variables.map((variable) => [variable.name, variable]),
          );
          const result = data(owner, variables);
          for (const syntax of declaration.constructors) {
            if (!/^[A-Z]/.test(syntax.name))
              return yield* fail("Constructor names must start with an uppercase letter").at(
                syntax.nameSpan,
              );
            if (known.has(syntax.name) || addedConstructors.has(syntax.name))
              return yield* fail(`Duplicate constructor: ${syntax.name}`).at(syntax.nameSpan);
            const fields: Binding<Type>[] = [];
            for (const field of syntax.fields) {
              const type = yield* resolveValueType(field, parameters);
              if (["forall", "qualified"].includes(prune(type).kind))
                return yield* fail("Polymorphic constructor fields are not supported").at(
                  field.span,
                );
              fields.push(code.binding("field", type));
            }
            const tag = `${owner.name}.${syntax.name}`;
            let initial = code.variant(
              result,
              tag,
              fields.map((field) => code.ref(field)),
            );
            for (const field of fields.toReversed()) {
              initial = code.fn(fn(field.type, initial.type), field, {
                declarations: [],
                result: initial,
              });
            }
            const type = variables.length ? forall(variables, initial.type) : initial.type;
            const value = yield* code.declare(syntax.name, { ...initial, type });
            const binding = value.node.binding;
            yield* define(binding, syntax.nameSpan, fields.length ? "function" : "variable");
            addedConstructors.set(syntax.name, { binding, type, arity: fields.length, tag, owner });
            entries.set(syntax.name, { binding, scheme: mono(type) });
          }
        }
        for (const definition of added.values())
          for (const parameter of definition.type.parameters ?? []) defaultKind(parameter);
        return yield* bind(constructors, addedConstructors, bind(env, entries, body));
      }),
    );
  });

const withClasses = <A>(declarations: readonly ClassDecl[], body: Check<A>): Check<A> =>
  check(function* () {
    const known = yield* get(classes);
    const environment = yield* get(env);
    const added = new Map<string, Class>();
    const entries = new Map<string, Entry>();
    for (const declaration of declarations) {
      if (known.has(declaration.name) || added.has(declaration.name))
        return yield* fail(`Duplicate class: ${declaration.name}`).at(declaration.nameSpan);
      const parameter = generic(
        declaration.parameter.name,
        declaration.parameter.kind ? kind(declaration.parameter.kind) : typeKind,
      );
      const methods = new Map<string, Type>();
      if (!declaration.methods.length)
        return yield* fail("Class requires a method").at(declaration.span);
      for (const method of declaration.methods) {
        if (environment.has(method.name) || entries.has(method.name) || methods.has(method.name))
          return yield* fail(`Duplicate class method: ${method.name}`).at(method.nameSpan);
        const type = yield* resolveValueType(method.type, new Map([[parameter.name, parameter]]));
        if (containsConstraints(type))
          return yield* fail("Class method contexts are not supported").at(method.span);
        const witness = fresh(0, kindOf(parameter));
        if (!free(substitute(type, new Map([[parameter, witness]]))).has(witness))
          return yield* fail(
            `Ambiguous class method: ${method.name} does not mention ${parameter.name}`,
          ).at(method.span);
        methods.set(method.name, type);
      }
      const definition = { parameter, methods };
      added.set(declaration.name, definition);
      const dictionary = record(row(methods));
      for (const method of declaration.methods) {
        const methodType = methods.get(method.name)!;
        const type = forall(
          [parameter],
          qualified([{ className: declaration.name, arg: parameter }], methodType),
        );
        const dict = code.binding("dictionary", dictionary);
        const value = yield* code.declare(
          method.name,
          code.fn(type, dict, {
            declarations: [],
            result: code.field(methodType, code.ref(dict), method.name),
          }),
        );
        const binding = value.node.binding;
        yield* define(binding, method.nameSpan, "function");
        entries.set(method.name, { binding, scheme: mono(type) });
      }
    }
    return yield* bind(classes, added, bind(env, entries, body));
  });

const withInstances = <A>(declarations: readonly InstanceDecl[], body: Check<A>): Check<A> =>
  check(function* () {
    const all = [...(yield* get(instances))];
    for (const declaration of declarations) {
      const definition = (yield* get(classes)).get(declaration.className);
      if (!definition)
        return yield* fail(`Unknown class: ${declaration.className}`).at(declaration.span);
      const arg = yield* resolve(declaration.arg);
      yield* unifyKinds(kindOf(arg), kindOf(definition.parameter)).at(declaration.arg.span);
      const { head } = decompose(arg);
      if (!["constructor", "number", "boolean", "string"].includes(head.kind) || free(arg).size)
        return yield* fail("Instance heads must be closed nominal types or primitives").at(
          declaration.arg.span,
        );
      const predicate = { className: declaration.className, arg };
      if (
        all.some(
          (entry) =>
            entry.predicate.className === predicate.className && sameType(entry.predicate.arg, arg),
        )
      )
        return yield* fail(
          `Duplicate or overlapping instance: ${predicate.className} ${show(arg)}`,
        ).at(declaration.span);
      const seen = new Set<string>();
      const fields: { name: string; value: Value<Type> }[] = [];
      for (const method of declaration.methods) {
        const original = definition.methods.get(method.name);
        if (!original)
          return yield* fail(`Unknown instance method: ${method.name}`).at(method.nameSpan);
        if (seen.has(method.name))
          return yield* fail(`Duplicate instance method: ${method.name}`).at(method.nameSpan);
        seen.add(method.name);
        const type = substitute(original, new Map([[definition.parameter, arg]]));
        if (yield* get(observe)) {
          yield* facts.typed(type, method.nameSpan);
          yield* facts.reference((yield* lookup(env, method.name)).binding, method.nameSpan);
        }
        const local: Wanted[] = [];
        const value = yield* within(
          instances,
          all.slice(),
          within(wanted, local, checkExpr(method.value, type)),
        );
        yield* requireEvidence(local);
        fields.push({ name: method.name, value });
      }
      const missing = [...definition.methods.keys()].filter((name) => !seen.has(name));
      if (missing.length)
        return yield* fail(`Missing instance methods: ${missing.join(", ")}`).at(declaration.span);
      const value = yield* code.declare(
        `${declaration.className}_dictionary`,
        code.record(yield* dictionaryType(predicate), fields),
      );
      all.push({ predicate, value, identity: value.node.binding.id });
    }
    return yield* within(instances, all, body);
  });

const withBindings = (module: Module, continuation: Check<Value<Type>>): Check<Value<Type>> =>
  check(function* () {
    const signatures = new Map<string, TypeExpr>();
    for (const signature of module.signatures) {
      if (signatures.has(signature.name))
        return yield* fail(`Duplicate signature: ${signature.name}`).at(signature.nameSpan);
      signatures.set(signature.name, signature.type);
    }
    const names = new Set<string>();
    for (const binding of module.bindings) {
      if (names.has(binding.name))
        return yield* fail(`Duplicate definition: ${binding.name}`).at(binding.nameSpan);
      names.add(binding.name);
    }
    for (const name of signatures.keys())
      if (!names.has(name)) return yield* fail(`Signature without definition: ${name}`);
    let result = continuation;
    for (const binding of module.bindings.toReversed()) {
      result = elaborateLet(
        {
          kind: "let",
          name: binding.name,
          nameSpan: binding.nameSpan,
          recursive: binding.recursive,
          annotation: signatures.get(binding.name),
          value: binding.value,
          body: binding.value,
          span: binding.span,
        },
        undefined,
        result,
      );
    }
    return yield* result;
  });

const withModule = (module: Module, body: Check<Value<Type>>): Check<Value<Type>> =>
  withTypes(
    module.types,
    withClasses(module.classes, withInstances(module.instances, withBindings(module, body))),
  );

const withPrelude = (body: Check<Value<Type>>): Check<Value<Type>> =>
  check(function* () {
    const unit = record(row());
    const entries = new Map<string, Entry>();
    const declare = (name: string, value: Value<Type>): Check<Binding<Type>> =>
      check(function* () {
        const reference = yield* code.declare(name, value);
        const binding = reference.node.binding;
        entries.set(name, { binding, scheme: generalize(value.type, []) });
        return binding;
      });
    const printed = code.binding("value", fresh());
    const printUnit = code.binding("unit", unit);
    yield* declare(
      "print",
      code.fn(fn(printed.type, effect(unit)), printed, {
        declarations: [],
        result: code.fn(effect(unit), printUnit, {
          declarations: [],
          result: code.print(unit, code.ref(printed)),
        }),
      }),
    );
    const pureValue = code.binding("value", fresh());
    const pureUnit = code.binding("unit", unit);
    yield* declare(
      "pureEffect",
      code.fn(fn(pureValue.type, effect(pureValue.type)), pureValue, {
        declarations: [],
        result: code.fn(effect(pureValue.type), pureUnit, {
          declarations: [],
          result: code.ref(pureValue),
        }),
      }),
    );
    const a = fresh();
    const b = fresh();
    const action = code.binding("action", effect(a));
    const callback = code.binding("next", fn(a, effect(b)));
    const bindUnit = code.binding("unit", unit);
    const applied = code.call(a, code.ref(action), code.ref(bindUnit));
    const next = code.call(effect(b), code.ref(callback), applied);
    yield* declare(
      "bindEffect",
      code.fn(fn(action.type, fn(callback.type, effect(b))), action, {
        declarations: [],
        result: code.fn(fn(callback.type, effect(b)), callback, {
          declarations: [],
          result: code.fn(effect(b), bindUnit, {
            declarations: [],
            result: code.call(b, next, code.ref(bindUnit)),
          }),
        }),
      }),
    );
    return yield* bind(
      definitions,
      [["Effect", { type: effectConstructor, constructors: [] }]],
      bind(env, entries, body),
    );
  });

// Evidence holes exist only while checking. Resolve them before handing the IR
// to the shared validator/emitter; no typeclass machinery enters the shared IR.
const resolveBody = (body: Body<Type>, solved: ReadonlyMap<symbol, Value<Type>>): Body<Type> => {
  const visit = (value: Value<Type>): Value<Type> => {
    const node = value.node;
    switch (node.kind) {
      case "ref":
        return solved.get(node.binding.id) ?? value;
      case "literal":
        return value;
      case "merge":
      case "binary":
        return { ...value, node: { ...node, left: visit(node.left), right: visit(node.right) } };
      case "call":
        return { ...value, node: { ...node, fn: visit(node.fn), arg: visit(node.arg) } };
      case "fn":
      case "block":
        return { ...value, node: { ...node, body: resolveBody(node.body, solved) } };
      case "if":
        return {
          ...value,
          node: {
            ...node,
            cond: visit(node.cond),
            then: resolveBody(node.then, solved),
            else: resolveBody(node.else, solved),
          },
        };
      case "record":
        return {
          ...value,
          node: {
            ...node,
            fields: node.fields.map((field) => ({ ...field, value: visit(field.value) })),
            ...(node.base ? { base: visit(node.base) } : {}),
          },
        };
      case "field":
        return { ...value, node: { ...node, record: visit(node.record) } };
      case "print":
        return { ...value, node: { ...node, value: visit(node.value) } };
      case "variant":
        return { ...value, node: { ...node, fields: node.fields.map(visit) } };
      case "match":
        return {
          ...value,
          node: {
            ...node,
            value: visit(node.value),
            cases: node.cases.map((branch) => ({
              ...branch,
              body: resolveBody(branch.body, solved),
            })),
            ...(node.fallback
              ? { fallback: { ...node.fallback, body: resolveBody(node.fallback.body, solved) } }
              : {}),
          },
        };
    }
  };
  return {
    declarations: body.declarations.map((declaration) => ({
      ...declaration,
      value: visit(declaration.value),
    })),
    result: visit(body.result),
  };
};

export type Compiled = {
  readonly type: Type;
  readonly ir: Body<Type>;
  readonly javascript: string;
};

const parse = (source: string): Result<Module> => {
  const result = program.parse(source);
  return result.success
    ? result
    : {
        success: false,
        error: {
          message: result.error.message,
          span: result.error.diagnostic.span,
          context: ["parsing", ...(result.error.diagnostic.context ?? [])],
        },
      };
};

type Exports = {
  values: Map<string, Entry>;
  types: Map<string, Definition>;
  constructors: Map<string, Constructor>;
  classes: Map<string, Class>;
  instances: Evidence[];
};

type Graph = { readonly root: string; readonly modules: readonly ModuleSource[] };

const emptyExports = (): Exports => ({
  values: new Map(),
  types: new Map(),
  constructors: new Map(),
  classes: new Map(),
  instances: [],
});

const mergeImports = (
  source: ModuleSource,
  modules: ReadonlyMap<string, Exports>,
): Check<Exports> =>
  check(function* () {
    const merged = emptyExports();
    const merge = <T>(
      target: Map<string, T>,
      input: ReadonlyMap<string, T>,
      identity: (value: T) => symbol,
      span: Span,
    ): Check<void> =>
      check(function* () {
        for (const [name, value] of input) {
          const previous = target.get(name);
          if (previous && identity(previous) !== identity(value))
            return yield* fail(`Conflicting imported name: ${name}`).at(span);
          target.set(name, value);
        }
      });
    for (const imported of source.imports) {
      const exported = modules.get(imported.uri)!;
      yield* merge(
        merged.values,
        exported.values,
        (entry) => entry.identity ?? entry.binding.id,
        imported.span,
      );
      yield* merge(merged.types, exported.types, (entry) => entry.type.id, imported.span);
      yield* merge(
        merged.constructors,
        exported.constructors,
        (entry) => entry.owner.id,
        imported.span,
      );
      yield* merge(merged.classes, exported.classes, (entry) => entry.parameter.id, imported.span);
      for (const instance of exported.instances) {
        const previous = merged.instances.find(
          (value) =>
            value.predicate.className === instance.predicate.className &&
            sameType(value.predicate.arg, instance.predicate.arg),
        );
        if (previous && previous.identity !== instance.identity)
          return yield* fail(
            `Conflicting imported instance: ${instance.predicate.className} ${show(instance.predicate.arg)}`,
          ).at(imported.span);
        if (!previous) merged.instances.push(instance);
      }
    }
    return merged;
  });

const build = (graph: Graph, locations: Map<symbol, Origin>): Check<Body<Type>> =>
  check(function* () {
    const solved = new Map<symbol, Value<Type>>();
    const body = yield* within(
      origins,
      locations,
      within(
        solutions,
        solved,
        code.body(
          withPrelude(
            check(function* () {
              const primitiveValues = yield* get(env);
              const primitiveTypes = yield* get(definitions);
              const checked = new Map<string, Exports>();
              for (const source of graph.modules) {
                const parsed = parse(source.source);
                if (!parsed.success)
                  return yield* fail(parsed.error.message)
                    .at(parsed.error.span)
                    .context(source.uri);
                const imported = yield* mergeImports(source, checked).context(source.uri);
                const root = source.uri === graph.root;
                const localWants: Wanted[] = [];
                let exported = emptyExports();
                const finish = check(function* () {
                  const values = yield* get(env);
                  const types = yield* get(definitions);
                  exported = {
                    values: new Map(
                      [...values].filter(
                        ([name, entry]) =>
                          primitiveValues.get(name)?.binding.id !== entry.binding.id,
                      ),
                    ),
                    types: new Map(
                      [...types].filter(
                        ([name, entry]) => primitiveTypes.get(name)?.type.id !== entry.type.id,
                      ),
                    ),
                    constructors: new Map(yield* get(constructors)),
                    classes: new Map(yield* get(classes)),
                    instances: [...(yield* get(instances))],
                  };
                  if (root && parsed.value.body) return yield* elaborate(parsed.value.body);
                  if (root && parsed.value.bindings.some((binding) => binding.name === "main")) {
                    const entry = values.get("main")!;
                    return yield* useValue(code.ref(entry.binding, instantiate(entry.scheme)), {
                      start: 0,
                      end: 0,
                    });
                  }
                  if (parsed.value.body)
                    yield* code.declare("module_result", yield* elaborate(parsed.value.body));
                  // All visible non-primitive names are exported, including re-exports.
                  // Dictionary fields are private to this elaboration, not source names.
                  const fields: { name: string; value: Value<Type> }[] = [...exported.values].map(
                    ([name, entry]) => ({
                      name,
                      value: code.ref(entry.binding, entry.scheme.type),
                    }),
                  );
                  for (const [index, instance] of exported.instances.entries())
                    fields.push({ name: `@instance${index}`, value: instance.value });
                  return code.record(
                    record(row(new Map(fields.map((field) => [field.name, field.value.type])))),
                    fields,
                  );
                });
                const computation = within(
                  currentModule,
                  source.uri,
                  within(
                    observe,
                    root,
                    within(
                      wanted,
                      localWants,
                      within(
                        env,
                        new Map([...primitiveValues, ...imported.values]),
                        within(
                          definitions,
                          new Map([...primitiveTypes, ...imported.types]),
                          within(
                            constructors,
                            imported.constructors,
                            within(
                              classes,
                              imported.classes,
                              within(
                                instances,
                                imported.instances,
                                code.scope(withModule(parsed.value, finish)),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                );
                const value = yield* computation.context(source.uri);
                yield* requireEvidence(localWants).context(source.uri);
                if (root) return value;
                const namespace = yield* code.declare("module", value);
                const rebound = emptyExports();
                rebound.types = exported.types;
                rebound.classes = exported.classes;
                for (const [name, entry] of exported.values) {
                  const reference = yield* code.declare(
                    name,
                    code.field(entry.scheme.type, namespace, name),
                  );
                  const binding = reference.node.binding;
                  rebound.values.set(name, {
                    binding,
                    scheme: entry.scheme,
                    identity: entry.identity ?? entry.binding.id,
                  });
                  const origin = locations.get(entry.binding.id);
                  if (origin)
                    locations.set(binding.id, {
                      ...origin,
                      id: binding.id,
                      name,
                      type: entry.scheme.type,
                    });
                }
                for (const [name, constructor] of exported.constructors)
                  rebound.constructors.set(name, {
                    ...constructor,
                    binding: rebound.values.get(name)!.binding,
                  });
                for (const [index, instance] of exported.instances.entries()) {
                  const reference = yield* code.declare(
                    "dictionary",
                    code.field(instance.value.type, namespace, `@instance${index}`),
                  );
                  rebound.instances.push({ ...instance, value: reference });
                }
                checked.set(source.uri, rebound);
              }
              throw new Error("Module graph has no root");
            }),
          ),
        ),
      ),
    );
    return resolveBody(body, solved);
  });

// Dependency diagnostics point at the importing directive, never at an unrelated
// same-numbered offset in the root file. The originating URI remains in context.
const moduleError = (
  error: import("langkit").Diagnostic,
  graph: Graph,
): import("langkit").Diagnostic => {
  const origin = error.context.find(
    (context) => context !== graph.root && graph.modules.some((module) => module.uri === context),
  );
  if (!origin) return error;
  const root = graph.modules.find((module) => module.uri === graph.root)!;
  const reaches = (uri: string): boolean =>
    uri === origin ||
    graph.modules
      .find((module) => module.uri === uri)!
      .imports.some((imported) => reaches(imported.uri));
  const imported = root.imports.find((imported) => reaches(imported.uri));
  return imported ? { ...error, span: imported.span } : error;
};

export const analyze = (source: string, options: ModuleOptions = {}): Analysis<Type> => {
  const loaded = loadModules(source, options, "strict");
  const lexical = highlight(source, tokens);
  if (!loaded.success)
    return {
      diagnostics: [loaded.error],
      types: [],
      definitions: [],
      references: [],
      tokens: lexical,
    };
  const locations = new Map<symbol, Origin>();
  const analysis = facts.collect(build(loaded.value, locations), lexical).analysis;
  const local = new Set(analysis.definitions.map((definition) => definition.id));
  const external = new Map<symbol, Origin>();
  for (const reference of analysis.references) {
    const origin = locations.get(reference.id);
    if (!local.has(reference.id) && origin && origin.uri !== loaded.value.root)
      external.set(reference.id, origin);
  }
  return {
    ...analysis,
    definitions: [...analysis.definitions, ...external.values()],
    diagnostics: analysis.diagnostics.map((error) => moduleError(error, loaded.value)),
    sources: new Map(loaded.value.modules.map((module) => [module.uri, module.original])),
  };
};

export const compile = (source: string, options: ModuleOptions = {}): Result<Compiled> => {
  const loaded = loadModules(source, options, "strict");
  if (!loaded.success) return loaded;
  const built = run(build(loaded.value, new Map()));
  if (!built.success) return { success: false, error: moduleError(built.error, loaded.value) };
  return {
    success: true,
    value: { type: built.value.result.type, ir: built.value, javascript: emit(built.value) },
  };
};

if (import.meta.main) {
  const uri = process.argv[2]
    ? pathToFileURL(resolvePath(process.argv[2])).href
    : new URL("./main.strict", import.meta.url).href;
  const source = readFileSync(new URL(uri), "utf8");
  const result = compile(source, { uri });
  if (!result.success) {
    console.error(render(result.error, source));
    process.exitCode = 1;
  } else {
    const { head } = decompose(result.value.type);
    if (head.kind === "constructor" && head.constructor.id === effectConstructor.id)
      runInNewContext(`(${result.value.javascript})({})`, { console }, { timeout: 1000 });
    else console.log(runInNewContext(result.value.javascript, { console }, { timeout: 1000 }));
  }
}
