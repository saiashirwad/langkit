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
  Check,
  type Result,
} from "langkit";
import { create, type Body, type Binding, type Value } from "langkit/ir";
import { create as createAnalysis, highlight, type Analysis } from "langkit/analysis";
import { emit } from "langkit/javascript";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, tokens, type Form } from "./shapes-syntax.ts";
import { macroName, template } from "./shapes-macros.ts";
import {
  boolean,
  number,
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
  mono,
  generalize,
  instantiate,
  show as showType,
  type Type,
  type Entry,
  type RowVariable,
} from "./shapes-types.ts";
export { type Type } from "./shapes-types.ts";
export type MacroInfo = {
  readonly kind: "macro";
  readonly name: string;
  readonly params: readonly string[];
  readonly result?: Type;
};
export type EditorType = Type | MacroInfo;
export const show = (type: EditorType): string => type.kind === "macro"
  ? `(macro ${type.name} [${type.params.join(" ")}]) — expression template; typechecked at use${type.result ? `\nExpanded result: ${showType(type.result)}` : ""}`
  : showType(type);
export { parse } from "./shapes-syntax.ts";

const code = create<Type>();
const facts = createAnalysis<EditorType>();
const env = scoped<ReadonlyMap<string, Entry>>(new Map());
const shapes = scoped<ReadonlyMap<string, Form>>(new Map());
type Macro = { readonly id: symbol; readonly name: string; readonly params: readonly string[]; readonly body: Form; readonly context: ExpansionContext };
type ExpansionContext = {
  readonly generated: boolean;
  readonly values: ReadonlyMap<string, Entry>;
  readonly macros: ReadonlyMap<string, Macro>;
  readonly shapes: ReadonlyMap<string, Form>;
};
const macros = scoped<ReadonlyMap<string, Macro>>(new Map());
const expansionDepth = scoped(0);
const generated = scoped(false);
const expansionBudget = scoped({ remaining: 10000 });
const argumentsAt = new WeakMap<Form, ExpansionContext>();
const capture = (): Check<ExpansionContext> => check(function* () {
  return { generated: yield* get(generated), values: yield* get(env), macros: yield* get(macros), shapes: yield* get(shapes) };
});
const inContext = <A>(context: ExpansionContext, body: Check<A>): Check<A> => check(function* () {
  // Invisible entries retain all ambient monomorphic variables for generalization.
  // Dropping caller bindings here would unsoundly generalize a substituted value.
  const values = new Map(context.values);
  const retained = new Set(values.values());
  let index = 0;
  for (const entry of (yield* get(env)).values()) {
    if (retained.has(entry)) continue;
    retained.add(entry);
    while (values.has(`\0${index}`)) index++;
    values.set(`\0${index++}`, entry);
  }
  return yield* within(generated, context.generated,
    within(env, values, within(macros, context.macros, within(shapes, context.shapes, body))));
});
const atom = (form: Form | undefined, text: string): boolean =>
  form?.kind === "symbol" && form.value === text;
const name = (form: Form): Check<string> =>
  form.kind === "symbol" && /^[a-zA-Z_][\w?!-]*$/.test(form.value)
    ? check(function* () {
        return form.value;
      })
    : fail("Expected a name").at(form.span);
const reserved = new Set([
  "true",
  "false",
  "fn",
  "let",
  "if",
  "def",
  "shape",
  "macro",
  "extend",
  "update",
  "select",
  "merge",
]);
const bindingName = (form: Form): Check<string> =>
  check(function* () {
    const key = yield* name(form);
    if (reserved.has(key)) return yield* fail(`Reserved binding name: ${key}`).at(form.span);
    return key;
  });
const arity = (form: Form, items: readonly Form[], count: number): Check<void> =>
  check(function* () {
    if (items.length !== count) yield* fail(`Expected ${count - 1} operands`).at(form.span);
  });

type TypeScope = { rows: Map<string, RowVariable>; types: Map<string, Type> };
const typeScope = (): TypeScope => ({ rows: new Map(), types: new Map() });
// An annotation constrains inference. Named shapes introduce a fresh open tail;
// literal records are exact unless an explicit ..row tail is supplied.
const annotation = (form: Form, scope: TypeScope, open = false): Check<Type> =>
  check(function* () {
    if (form.kind === "symbol") {
      if (form.value === "number") return number;
      if (form.value === "boolean") return boolean;
      if (form.value === "string") return string;
      if (/^'[a-zA-Z_]\w*$/.test(form.value)) {
        if (!scope.types.has(form.value)) scope.types.set(form.value, fresh());
        return scope.types.get(form.value)!;
      }
      const shape = (yield* get(shapes)).get(form.value);
      if (!shape) return yield* fail(`Unknown type: ${form.value}`);
      return yield* annotation(shape, typeScope(), true);
    }
    if (form.kind === "record") {
      const fields = new Map<string, Type>();
      let tail: RowVariable | null = open ? freshRow() : null;
      for (let i = 0; i < form.items.length; i += 2) {
        const label = form.items[i]!;
        if (label.kind === "symbol" && label.value.startsWith("..")) {
          if (!/^\.\.[a-zA-Z_]\w*$/.test(label.value) || i !== form.items.length - 1)
            return yield* fail("A row tail must be named and appear last").at(label.span);
          if (!scope.rows.has(label.value)) scope.rows.set(label.value, freshRow());
          tail = scope.rows.get(label.value)!;
          break;
        }
        const key = yield* name(label);
        if (fields.has(key)) return yield* fail(`Duplicate field: ${key}`).at(label.span);
        const value = form.items[i + 1];
        if (!value) return yield* fail(`Missing type for field: ${key}`);
        fields.set(key, yield* annotation(value, scope));
      }
      if (tail) yield* exclude(row(new Map(), tail), fields.keys());
      return record(row(fields, tail));
    }
    if (form.kind === "list" && atom(form.items[0], "->") && form.items.length >= 3) {
      const types: Type[] = [];
      for (const item of form.items.slice(1)) types.push(yield* annotation(item, scope));
      let result = types.pop()!;
      for (const param of types.reverse()) result = fn(param, result);
      return result;
    }
    return yield* fail(
      "Expected a type: number, boolean, string, 'a, a shape, a record, or (-> A B)",
    );
  }).at(form.span);

const fields = (form: Form): Check<{ name: string; value: Value<Type> }[]> =>
  check(function* () {
    if (form.kind !== "record") return yield* fail("Expected a record literal").at(form.span);
    if (form.items.length % 2)
      return yield* fail("Record fields need name/value pairs").at(form.span);
    const result: { name: string; value: Value<Type> }[] = [];
    const labels = new Set<string>();
    for (let i = 0; i < form.items.length; i += 2) {
      const key = yield* name(form.items[i]!);
      if (labels.has(key)) return yield* fail(`Duplicate field: ${key}`).at(form.items[i]!.span);
      labels.add(key);
      result.push({ name: key, value: yield* elaborate(form.items[i + 1]!) });
    }
    return result;
  });

const requireField = (base: Type, key: string): Check<{ type: Type; tail: RowVariable }> =>
  check(function* () {
    const type = fresh();
    const tail = freshRow([key]);
    yield* unify(base, record(row(new Map([[key, type]]), tail)));
    return { type, tail };
  });

export const elaborate = (form: Form): Check<Value<Type>> => {
  const context = argumentsAt.get(form);
  return context ? inContext(context, elaborateForm(form)) : elaborateForm(form);
};
const elaborateForm = (form: Form): Check<Value<Type>> =>
  check(function* () {
    if ((yield* get(expansionDepth)) > 0 && --(yield* get(expansionBudget)).remaining < 0)
      return yield* fail("Macro expansion resource limit exceeded");
    if (form.kind === "string") return code.literal(string, form.value);
    if (form.kind === "symbol") {
      if (form.value === "true" || form.value === "false")
        return code.literal(boolean, form.value === "true");
      if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(form.value)) {
        const value = Number(form.value);
        if (!Number.isFinite(value)) return yield* fail("Number literal is too large");
        return code.literal(number, value);
      }
      const { binding, scheme } = yield* lookup(env, form.value);
      if (!(yield* get(generated))) yield* facts.reference(binding, form.span);
      return code.ref(binding, instantiate(scheme));
    }
    if (form.kind === "record") {
      const values = yield* fields(form);
      return code.record(
        record(row(new Map(values.map(({ name, value }) => [name, value.type])))),
        values,
      );
    }
    if (form.kind !== "list" || !form.items.length) return yield* fail("Expected an expression");
    const items = form.items;
    const head = items[0]!;
    const macro = head.kind === "symbol" && !argumentsAt.has(head) && !(yield* get(env)).has(head.value)
      ? (yield* get(macros)).get(head.value) : undefined;
    if (macro) {
      const visible = !(yield* get(generated));
      const nameSpan = { start: head.span.start, end: head.span.start + macro.name.length };
      if (visible) yield* facts.reference(macro, nameSpan);
      if (items.length - 1 !== macro.params.length)
        return yield* fail(`Macro ${head.kind === "symbol" ? head.value : ""} expects ${macro.params.length} arguments`);
      const depth = yield* get(expansionDepth);
      if (depth >= 32) return yield* fail("Macro expansion depth limit exceeded");
      const caller = yield* capture();
      const argumentsByName = new Map(macro.params.map((param, i) => [param, items[i + 1]!]));
      const expanded = yield* template(macro.body, (reference, bound) => check(function* () {
        const argument = bound.has(reference.value) ? undefined : argumentsByName.get(reference.value);
        if (!argument) return reference;
        const copy = { ...argument };
        argumentsAt.set(copy, argumentsAt.get(argument) ?? caller);
        return copy;
      }), form.span);
      const body = within(expansionDepth, depth + 1, inContext({ ...macro.context, generated: true }, elaborate(expanded)));
      const value = yield* new Check((runtime) => {
        const result = body.context(`expanding macro ${head.kind === "symbol" ? head.value : ""}`).step(runtime);
        return result.success ? result : { success: false, error: { ...result.error, span: form.span } };
      });
      if (visible) yield* facts.typed({ kind: "macro", name: macro.name, params: macro.params, result: value.type }, nameSpan);
      return value;
    }
    if (atom(head, "fn")) {
      yield* arity(form, items, 3);
      const params = items[1]!;
      if (params.kind !== "vector" || !params.items.length)
        return yield* fail("fn needs a nonempty parameter vector");
      const scope = typeScope();
      const bindings: Binding<Type>[] = [];
      const seen = new Set<string>();
      for (const param of params.items) {
        let label: Form = param;
        let type = fresh() as Type;
        if (param.kind === "list") {
          if (param.items.length !== 2)
            return yield* fail("Annotated parameter syntax: (name Type)").at(param.span);
          label = param.items[0]!;
          type = yield* annotation(param.items[1]!, scope);
        }
        const key = yield* bindingName(label);
        if (seen.has(key)) return yield* fail(`Duplicate parameter: ${key}`).at(label.span);
        seen.add(key);
        const binding = code.binding(key, type);
        if (!(yield* get(generated))) yield* facts.define(binding, label.span, "parameter");
        bindings.push(binding);
      }
      const lambda = (index: number): Check<Value<Type>> =>
        check(function* () {
          const param = bindings[index]!;
          const body = yield* code.body(
            bind(
              env,
              [[param.name, { binding: param, scheme: mono(param.type) }]],
              index === bindings.length - 1 ? elaborate(items[2]!) : lambda(index + 1),
            ),
          );
          return code.fn(fn(param.type, body.result.type), param, body);
        });
      return yield* lambda(0);
    }
    if (atom(head, "let")) {
      yield* arity(form, items, 3);
      const bindings = items[1]!;
      if (bindings.kind !== "vector" || bindings.items.length % 2)
        return yield* fail("let syntax: (let [name value ...] body)");
      const next = (index: number): Check<Value<Type>> =>
        check(function* () {
          if (index === bindings.items.length) return yield* elaborate(items[2]!);
          const label = bindings.items[index]!;
          const key = yield* bindingName(label);
          const initial = yield* elaborate(bindings.items[index + 1]!);
          const scheme = generalize(initial.type, yield* get(env));
          const value = yield* code.declare(key, initial);
          if (!(yield* get(generated))) yield* facts.define(value.node.binding, label.span, "variable");
          return yield* bind(
            env,
            [[key, { binding: value.node.binding, scheme }]],
            next(index + 2),
          );
        });
      return yield* code.scope(next(0));
    }
    if (atom(head, "if")) {
      yield* arity(form, items, 4);
      const cond = yield* elaborate(items[1]!);
      yield* unify(cond.type, boolean).at(items[1]!.span);
      const then = yield* code.body(elaborate(items[2]!));
      const otherwise = yield* code.body(elaborate(items[3]!));
      yield* unify(then.result.type, otherwise.result.type).at(items[3]!.span);
      return code.conditional(then.result.type, cond, then, otherwise);
    }
    if (atom(head, ".")) {
      yield* arity(form, items, 3);
      const base = yield* elaborate(items[1]!);
      const key = yield* name(items[2]!);
      const { type } = yield* requireField(base.type, key);
      return code.field(type, base, key);
    }
    if (atom(head, "update")) {
      yield* arity(form, items, 4);
      return yield* code.scope(
        check(function* () {
          // Bind the base before the replacement: evaluate once, left to right.
          const base = yield* code.declare("record", yield* elaborate(items[1]!));
          const key = yield* name(items[2]!);
          const { tail } = yield* requireField(base.type, key);
          const value = yield* elaborate(items[3]!);
          return code.record(
            record(row(new Map([[key, value.type]]), tail)),
            [{ name: key, value }],
            base,
          );
        }),
      );
    }
    if (atom(head, "extend") || atom(head, "merge")) {
      yield* arity(form, items, 3);
      return yield* code.scope(
        check(function* () {
          const base = yield* code.declare("record", yield* elaborate(items[1]!));
          const tail = freshRow();
          yield* unify(base.type, record(row(new Map(), tail)));
          if (atom(head, "extend")) {
            const values = yield* fields(items[2]!);
            const added = new Map(values.map(({ name, value }) => [name, value.type]));
            yield* exclude(row(new Map(), tail), added.keys());
            return code.record(record(row(added, tail)), values, base);
          }
          const right = yield* code.declare("fields", yield* elaborate(items[2]!));
          const type = prune(right.type);
          if (type.kind !== "record" || flatten(type.row).tail)
            return yield* fail(
              "merge needs a statically closed right-hand record; use extend for inferred open rows",
            );
          const added = flatten(type.row).fields;
          yield* exclude(row(new Map(), tail), added.keys());
          return code.merge(record(row(added, tail)), base, right);
        }),
      );
    }
    if (atom(head, "select")) {
      yield* arity(form, items, 3);
      const labels = items[2]!;
      if (labels.kind !== "vector")
        return yield* fail("select syntax: (select record [field ...])");
      return yield* code.scope(
        check(function* () {
          const base = yield* code.declare("record", yield* elaborate(items[1]!));
          yield* unify(base.type, record(row(new Map(), freshRow())));
          const values: { name: string; value: Value<Type> }[] = [];
          const types = new Map<string, Type>();
          for (const label of labels.items) {
            const key = yield* name(label);
            if (types.has(key)) return yield* fail(`Duplicate field: ${key}`).at(label.span);
            const { type } = yield* requireField(base.type, key);
            values.push({ name: key, value: code.field(type, base, key) });
            types.set(key, type);
          }
          return code.record(record(row(types)), values);
        }),
      );
    }
    if (atom(head, "def") || atom(head, "shape") || atom(head, "macro"))
      return yield* fail("Definitions are only allowed at the top level");
    if (items.length < 2) return yield* fail("A call needs at least one argument");
    let callee = yield* elaborate(head);
    for (const arg of items.slice(1)) {
      const value = yield* elaborate(arg);
      const result = fresh();
      yield* unify(callee.type, fn(value.type, result)).at(arg.span);
      callee = code.call(result, callee, value);
    }
    return callee;
  })
    .flatMap((value) =>
      check(function* () {
        if (!(yield* get(generated))) yield* facts.typed(value.type, form.span);
        return code.at(value, form.span);
      }),
    )
    .at(form.span);

const primitives = (): Check<ReadonlyMap<string, Entry>> =>
  check(function* () {
    const environment = new Map<string, Entry>();
    const add = (name: string, value: Value<Type>): Check<void> =>
      check(function* () {
        const ref = yield* code.declare(name, value);
        environment.set(name, {
          binding: ref.node.binding,
          scheme: generalize(value.type, new Map()),
        });
      });
    for (const op of ["+", "-", "*", "/", ">", "==", "concat"] as const) {
      const input = op === "concat" ? string : number;
      const output = op === ">" || op === "==" ? boolean : input;
      const a = code.binding("left", input);
      const b = code.binding("right", input);
      yield* add(
        op,
        code.fn(fn(input, fn(input, output)), a, {
          declarations: [],
          result: code.fn(fn(input, output), b, {
            declarations: [],
            result: code.binary(output, op === "concat" ? "+" : op, code.ref(a), code.ref(b)),
          }),
        }),
      );
    }
    const value = code.binding("value", fresh());
    const unit = record(row());
    yield* add(
      "print",
      code.fn(fn(value.type, unit), value, {
        declarations: [],
        result: code.print(unit, code.ref(value)),
      }),
    );
    return environment;
  });

const build = (forms: readonly Form[]): Check<Body<Type>> =>
  code.body(
    check(function* () {
      const environment = yield* primitives();
      const definitions = new Set<string>();
      const next = (index: number): Check<Value<Type>> =>
        check(function* () {
          const form = forms[index];
          if (!form) return yield* fail("A Shapes program must end with an expression");
          if (form.kind === "list" && atom(form.items[0], "macro")) {
            yield* arity(form, form.items, 4);
            const key = yield* macroName(form.items[1]!);
            if ((yield* get(macros)).has(key) || (yield* get(env)).has(key))
              return yield* fail(`Duplicate macro or value name: ${key}`).at(form.items[1]!.span);
            const vector = form.items[2]!;
            if (vector.kind !== "vector") return yield* fail("Macro parameters need a vector").at(vector.span);
            const params: string[] = [];
            for (const param of vector.items) {
              const name = yield* macroName(param);
              if (params.includes(name)) return yield* fail(`Duplicate macro parameter: ${name}`).at(param.span);
              params.push(name);
            }
            const context = yield* capture();
            const body = form.items[3]!;
            yield* template(body, (reference, bound, callee) => check(function* () {
              const text = reference.value;
              const target = callee && !bound.has(text) && !params.includes(text) && !context.values.has(text)
                ? context.macros.get(text) : undefined;
              if (target) {
                const span = { start: reference.span.start, end: reference.span.start + text.length };
                yield* facts.reference(target, span);
                yield* facts.typed({ kind: "macro", name: target.name, params: target.params }, span);
              }
              if (bound.has(text) || params.includes(text) || context.values.has(text) ||
                  text === "true" || text === "false" || /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text) ||
                  (callee && context.macros.has(text))) return reference;
              return yield* fail(`Unknown definition-site identifier in macro ${key}: ${text}`).at(reference.span);
            }));
            const macro: Macro = { id: Symbol(key), name: key, params, body, context };
            yield* facts.define({ ...macro, type: { kind: "macro", name: key, params } }, { start: form.items[1]!.span.start, end: form.items[1]!.span.start + key.length }, "function");
            return yield* bind(macros, [[key, macro]], next(index + 1));
          }
          if (form.kind === "list" && atom(form.items[0], "shape")) {
            yield* arity(form, form.items, 3);
            const label = form.items[1]!;
            const key = yield* name(label);
            if (["number", "boolean", "string"].includes(key) || (yield* get(shapes)).has(key))
              return yield* fail(`Duplicate shape: ${key}`).at(label.span);
            const body = form.items[2]!;
            if (
              body.kind !== "record" ||
              body.items.some((item) => item.kind === "symbol" && item.value.startsWith(".."))
            )
              return yield* fail("A shape definition needs a record without a row tail").at(
                body.span,
              );
            // Resolve now against earlier definitions; storing syntax freshens each use.
            yield* annotation(body, typeScope());
            return yield* bind(shapes, [[key, body]], next(index + 1));
          }
          if (form.kind === "list" && atom(form.items[0], "def")) {
            yield* arity(form, form.items, 3);
            const label = form.items[1]!;
            const key = yield* bindingName(label);
            if (definitions.has(key))
              return yield* fail(`Duplicate definition: ${key}`).at(label.span);
            definitions.add(key);
            const initial = yield* elaborate(form.items[2]!);
            const scheme = generalize(initial.type, yield* get(env));
            const ref = yield* code.declare(key, initial);
            yield* facts.define(
              ref.node.binding,
              label.span,
              prune(initial.type).kind === "function" ? "function" : "variable",
            );
            return yield* bind(
              env,
              [[key, { binding: ref.node.binding, scheme }]],
              next(index + 1),
            );
          }
          if (index !== forms.length - 1)
            return yield* fail("Only the final top-level form may be an expression").at(form.span);
          return yield* elaborate(form);
        });
      return yield* within(expansionBudget, { remaining: 10000 }, within(expansionDepth, 0,
        within(macros, new Map(), within(shapes, new Map(), within(env, environment, next(0))))));
    }),
  );

export type Compiled = {
  readonly type: Type;
  readonly ir: Body<Type>;
  readonly javascript: string;
};
export const compile = (source: string): Result<Compiled> => {
  const parsed = parse(source);
  if (!parsed.success) return parsed;
  const built = run(build(parsed.value));
  if (!built.success) return built;
  return {
    success: true,
    value: { type: built.value.result.type, ir: built.value, javascript: emit(built.value) },
  };
};
export const analyze = (source: string): Analysis<EditorType> => {
  const lexical = highlight(source, tokens);
  const parsed = parse(source);
  if (!parsed.success)
    return {
      diagnostics: [parsed.error],
      types: [],
      definitions: [],
      references: [],
      tokens: lexical,
    };
  return facts.collect(build(parsed.value), lexical).analysis;
};

if (import.meta.main) {
  const file = process.argv[2]
    ? pathToFileURL(resolve(process.argv[2]))
    : new URL("./main.shapes", import.meta.url);
  const source = readFileSync(file, "utf8");
  const result = compile(source);
  if (!result.success) {
    console.error(render(result.error, source));
    process.exitCode = 1;
  } else {
    console.log(runInNewContext(result.value.javascript, { console }, { timeout: 1000 }));
  }
}
