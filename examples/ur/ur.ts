import { check, fail, render, run, type Check, type Result } from "langkit";
import { create, type Binding, type Body, type Value } from "langkit/ir";
import { create as createAnalysis, highlight, type Analysis } from "langkit/analysis";
import { emit } from "langkit/javascript";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { program, tokens, type Declaration, type Expr, type Parameter as SyntaxParameter } from "./ur-syntax.ts";
import {
  apply, boolean, concat, disjoint, expect, fn, number, record, resolve, resolveRow, row, show, string,
  type Constraint, type Parameter, type Type, type TypeScope,
} from "./ur-types.ts";
export { show, type Type } from "./ur-types.ts";

const code = create<Type>();
const facts = createAnalysis<Type>();
type Context = {
  readonly values: ReadonlyMap<string, Binding<Type>>;
  readonly types: TypeScope;
  readonly constraints: readonly Constraint[];
};
const empty: Context = { values: new Map(), types: new Map(), constraints: [] };
const withValue = (context: Context, binding: Binding<Type>): Context => ({ ...context, values: new Map(context.values).set(binding.name, binding) });

const parameters = (params: readonly SyntaxParameter[], context: Context): Check<Binding<Type>[]> => check(function* () {
  const seen = new Set<string>();
  const bindings: Binding<Type>[] = [];
  for (const p of params) {
    if (seen.has(p.name)) return yield* fail(`Duplicate parameter: ${p.name}`).at(p.span);
    seen.add(p.name);
    const binding = code.binding(p.name, yield* resolve(p.type, context.types, context.constraints));
    yield* facts.define(binding, p.span, "parameter"); bindings.push(binding);
  }
  return bindings;
});
// Surface calls are exact-arity. The shared unary IR represents an n-argument
// function as nested closures, with an erased empty-record argument for arity 0.
const lambda = (params: readonly Binding<Type>[], body: Body<Type>, type: Type): Value<Type> => {
  if (!params.length) return code.fn(type, code.binding("unit", record(row())), body);
  let value: Value<Type> = body.result;
  for (let i = params.length - 1; i >= 0; i--) {
    const intermediate = i === 0 ? type : fn(params.slice(i).map(p => p.type), body.result.type);
    value = code.fn(intermediate, params[i]!, i === params.length - 1 ? body : { declarations: [], result: value });
  }
  return value;
};

const elaborate = (expr: Expr, context: Context): Check<Value<Type>> => check(function* () {
  switch (expr.kind) {
    case "literal": return code.literal(typeof expr.value === "number" ? number : typeof expr.value === "boolean" ? boolean : string, expr.value);
    case "name": {
      const binding = context.values.get(expr.name);
      if (!binding) return yield* fail(`Unknown value: ${expr.name}`);
      yield* facts.reference(binding, expr.span); return code.ref(binding);
    }
    case "record": {
      const fields: { name: string; value: Value<Type> }[] = [];
      const types = new Map<string, Type>();
      for (const field of expr.fields) {
        if (types.has(field.name.name)) return yield* fail(`Duplicate field: ${field.name.name}`).at(field.name.span);
        const value = yield* elaborate(field.value, context);
        fields.push({ name: field.name.name, value }); types.set(field.name.name, value.type);
      }
      return code.record(record(row(types)), fields);
    }
    case "field": {
      const value = yield* elaborate(expr.record, context);
      if (value.type.kind !== "record") return yield* fail(`Expected a record, found ${show(value.type)}`);
      const type = value.type.row.fields.get(expr.name.name);
      if (!type) return yield* fail(`Unknown field: ${expr.name.name}; fields of an abstract row cannot be projected`).at(expr.name.span);
      return code.field(type, value, expr.name.name);
    }
    case "binary": {
      const left = yield* elaborate(expr.left, context), right = yield* elaborate(expr.right, context);
      if (expr.op === "++") {
        if (left.type.kind !== "record" || right.type.kind !== "record") return yield* fail("Record concatenation requires two records");
        return code.merge(record(yield* concat(left.type.row, right.type.row, context.constraints)), left, right);
      }
      if (expr.op === "==") {
        if (!["number", "boolean", "string"].includes(left.type.kind)) return yield* fail("Equality is supported only for primitive values");
        yield* expect(right.type, left.type); return code.binary(boolean, expr.op, left, right);
      }
      yield* expect(left.type, number); yield* expect(right.type, number);
      return code.binary(expr.op === ">" ? boolean : number, expr.op, left, right);
    }
    case "call": {
      const callee = yield* elaborate(expr.fn, context);
      if (callee.type.kind !== "function") return yield* fail(`Expected a function, found ${show(callee.type)}`);
      const args: Value<Type>[] = [];
      for (const arg of expr.args) args.push(yield* elaborate(arg, context));
      const result = yield* apply(callee.type, args.map(a => a.type), context.constraints);
      let value = callee;
      if (!args.length) return code.call(result, callee, code.record(record(row()), []));
      for (let i = 0; i < args.length; i++) value = code.call(i === args.length - 1 ? result : fn(args.slice(i + 1).map(a => a.type), result), value, args[i]!);
      return value;
    }
    case "lambda": {
      const params = yield* parameters(expr.params, context);
      let inner = context;
      for (const p of params) inner = withValue(inner, p);
      const body = yield* code.body(elaborate(expr.body, inner));
      return lambda(params, body, fn(params.map(p => p.type), body.result.type));
    }
    case "let": return yield* code.scope(check(function* () {
      const value = yield* elaborate(expr.value, context);
      if (expr.annotation) yield* expect(value.type, yield* resolve(expr.annotation, context.types, context.constraints));
      const ref = yield* code.declare(expr.name.name, value);
      yield* facts.define(ref.node.binding, expr.name.span, value.type.kind === "function" ? "function" : "variable");
      return yield* elaborate(expr.body, withValue(context, ref.node.binding));
    }));
    case "if": {
      const cond = yield* elaborate(expr.cond, context); yield* expect(cond.type, boolean);
      const then = yield* code.body(elaborate(expr.then, context));
      const otherwise = yield* code.body(elaborate(expr.else, context));
      yield* expect(otherwise.result.type, then.result.type);
      return code.conditional(then.result.type, cond, then, otherwise);
    }
  }
}).flatMap(value => check(function* () {
  yield* facts.typed(value.type, expr.span); return code.at(value, expr.span);
})).at(expr.span);

const declaration = (decl: Declaration, context: Context): Check<Value<Type>> => check(function* () {
  if (decl.kind === "let") {
    const value = yield* elaborate(decl.value, context);
    if (decl.annotation) yield* expect(value.type, yield* resolve(decl.annotation, context.types, context.constraints));
    return value;
  }
  const types = new Map<string, Parameter>();
  for (const g of decl.generics) {
    if (types.has(g.name) || ["number", "boolean", "string"].includes(g.name)) return yield* fail(`Duplicate or reserved type parameter: ${g.name}`).at(g.span);
    types.set(g.name, { id: Symbol(g.name), name: g.name, row: g.row });
  }
  const constraints: Constraint[] = [];
  for (const c of decl.constraints) {
    const left = yield* resolveRow(c.left, types, constraints), right = yield* resolveRow(c.right, types, constraints);
    const constraint = { left, right };
    // Reject internally contradictory constraints rather than assuming false.
    yield* disjoint(left, right, [constraint]).at(c.span);
    constraints.push(constraint);
  }
  let inner: Context = { values: context.values, types, constraints };
  const params = yield* parameters(decl.params, inner);
  const result = yield* resolve(decl.result, types, constraints);
  for (const p of params) inner = withValue(inner, p);
  const body = yield* code.body(elaborate(decl.body, inner));
  yield* expect(body.result.type, result).at(decl.body.span);
  return lambda(params, body, fn(params.map(p => p.type), result, [...types.values()], constraints));
}).at(decl.span).context(decl.name.name);

const build = (declarations: readonly Declaration[], entry: boolean): Check<Body<Type>> => code.body(check(function* () {
  let context = empty;
  for (const decl of declarations) {
    if (context.values.has(decl.name.name)) return yield* fail(`Duplicate declaration: ${decl.name.name}`).at(decl.name.span);
    const value = yield* declaration(decl, context);
    const ref = yield* code.declare(decl.name.name, value);
    yield* facts.define(ref.node.binding, decl.name.span, value.type.kind === "function" ? "function" : "variable");
    context = withValue(context, ref.node.binding);
  }
  const main = context.values.get("main");
  if (!main && entry) return yield* fail("Missing entry value: main");
  return main ? code.ref(main) : code.record(record(row()), []);
}));
const parse = (source: string): Result<readonly Declaration[]> => {
  const parsed = program.parse(source);
  return parsed.success ? parsed : { success: false, error: {
    message: parsed.error.message, span: parsed.error.diagnostic.span,
    context: ["parsing", ...(parsed.error.diagnostic.context ?? [])],
  } };
};
export type Compiled = { readonly type: Type; readonly ir: Body<Type>; readonly javascript: string };
export const compile = (source: string): Result<Compiled> => {
  const parsed = parse(source); if (!parsed.success) return parsed;
  const built = run(build(parsed.value, true)); if (!built.success) return built;
  return { success: true, value: { type: built.value.result.type, ir: built.value, javascript: emit(built.value) } };
};
export const analyze = (source: string): Analysis<Type> => {
  const lexical = highlight(source, tokens), parsed = parse(source);
  if (!parsed.success) return { diagnostics: [parsed.error], types: [], definitions: [], references: [], tokens: lexical };
  return facts.collect(build(parsed.value, false), lexical).analysis;
};
if (import.meta.main) {
  const file = process.argv[2] ?? new URL("./main.ur", import.meta.url);
  try {
    const source = readFileSync(file, "utf8"), result = compile(source);
    if (!result.success) { console.error(render(result.error, source)); process.exitCode = 1; }
    else console.log(runInNewContext(result.value.javascript, {}, { timeout: 1000 }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  }
}
