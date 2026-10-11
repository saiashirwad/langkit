import { check, fail, render, run, type Check, type Diagnostic, type Result } from "langkit";
import { create, type Binding, type Body, type Program, type Value } from "langkit/ir";
import { elaboration } from "langkit/ir/check";
import { create as createAnalysis, highlight, type Analysis } from "langkit/analysis";
import { createJavaScriptEmitter } from "langkit/javascript";
import { coreJavaScript } from "langkit/javascript/core";
import { records } from "langkit/operations/records";
import { printing } from "langkit/operations/printing";
import { folders } from "langkit/operations/folders";
import { recordsJavaScript } from "langkit/javascript/records";
import { printingJavaScript } from "langkit/javascript/printing";
import { foldersJavaScript } from "langkit/javascript/folders";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  program,
  tokens,
  type Declaration,
  type Expr,
  type Parameter as SyntaxParameter,
} from "./ur-syntax.ts";
import {
  apply,
  alias,
  bindGenerics,
  resolveConstructor,
  typeKind,
  rowKind,
  arrowKind,
  variable,
  folder,
  mapRow,
  resolveRow,
  boolean,
  concat,
  disjoint,
  expect,
  fn,
  number,
  record,
  resolve,
  resolveConstraintRow,
  row,
  show,
  string,
  type Constraint,
  type Parameter,
  type Type,
  type TypeScope,
} from "./ur-types.ts";

export { show, type Type } from "./ur-types.ts";

const recordFeature = records<Type>();
const printingFeature = printing<Type>();
const folderFeature = folders<Type>();
const pureCode = create<Type>().use(recordFeature).use(printingFeature).use(folderFeature);
const code = elaboration(pureCode);
const javascript = createJavaScriptEmitter<Type>(
  coreJavaScript<Type>(pureCode.coreDescriptors),
  recordsJavaScript<Type>(recordFeature.descriptors),
  printingJavaScript<Type>(printingFeature.descriptors),
  foldersJavaScript<Type>(folderFeature.descriptors),
);
const facts = createAnalysis<Type>();

type Context = {
  readonly values: ReadonlyMap<string, Binding<Type>>;
  readonly types: TypeScope;
  readonly constraints: readonly Constraint[];
};

const empty: Context = { values: new Map(), types: new Map(), constraints: [] };

const withValue = (context: Context, binding: Binding<Type>): Context => ({
  ...context,
  values: new Map(context.values).set(binding.name, binding),
});

const parameters = (params: readonly SyntaxParameter[], context: Context): Check<Binding<Type>[]> =>
  check(function* () {
    const seen = new Set<string>();
    const bindings: Binding<Type>[] = [];
    for (const p of params) {
      if (seen.has(p.name)) return yield* fail(`Duplicate parameter: ${p.name}`).at(p.span);
      seen.add(p.name);
      const binding = code.binding(
        p.name,
        yield* resolve(p.type, context.types, context.constraints),
      );
      yield* facts.define(binding, p.span, "parameter");
      bindings.push(binding);
    }
    return bindings;
  });

const lambda = (params: readonly Binding<Type>[], body: Body<Type>, type: Type): Check<Value<Type>> =>
  code.check(function* () {
    if (!params.length) return code.fn(type, code.binding("unit", record(row())), body);
    let value: Value<Type> = body.result;
    for (let i = params.length - 1; i >= 0; i--) {
      const intermediate =
        i === 0
          ? type
          : fn(
              params.slice(i).map((p) => p.type),
              body.result.type,
            );
      const inner =
        i === params.length - 1
          ? body
          : yield* code.body(function* () {
              return value;
            });
      value = code.fn(intermediate, params[i]!, inner);
    }
    return value;
  });

const elaborate = (expr: Expr, context: Context): Check<Value<Type>> =>
  check(function* () {
    switch (expr.kind) {
      case "block":
        return yield* code.scope(function* () {
            let inner = context;
            const names = new Set<string>();
            for (const statement of expr.statements) {
              if (statement.kind === "binding" && names.has(statement.name.name))
                return yield* fail(`Duplicate local declaration: ${statement.name.name}`).at(
                  statement.name.span,
                );
              const value = yield* elaborate(statement.value, inner);
              if (statement.kind === "expression") {
                yield* code.declare("statement", value);
                continue;
              }
              if (statement.annotation)
                yield* expect(
                  value.type,
                  yield* resolve(statement.annotation, inner.types, inner.constraints),
                ).at(statement.span);
              const ref = yield* code.declare(statement.name.name, value);
              yield* facts.define(
                ref.node.binding,
                statement.name.span,
                value.type.kind === "function" ? "function" : "variable",
              );
              names.add(statement.name.name);
              inner = withValue(inner, ref.node.binding);
            }
            return code.record(record(row()), []);
          });
      case "folder": {
        const r = yield* resolveRow(expr.row, context.types, context.constraints);
        if (r.variables.length) return yield* fail("Folder construction requires a closed row");
        const seen = new Set<string>();
        for (const field of expr.fields) {
          if (seen.has(field.name))
            return yield* fail(`Duplicate folder field: ${field.name}`).at(field.span);
          if (!r.fields.has(field.name))
            return yield* fail(`Unknown folder field: ${field.name}`).at(field.span);
          seen.add(field.name);
        }
        const missing = [...r.fields.keys()].filter((name) => !seen.has(name));
        if (missing.length) return yield* fail(`Missing folder fields: ${missing.join(", ")}`);
        return code.fieldOrder(
          folder(r),
          expr.fields.map((field) => field.name),
        );
      }
      case "literal":
        return code.literal(
          typeof expr.value === "number"
            ? number
            : typeof expr.value === "boolean"
              ? boolean
              : string,
          expr.value,
        );
      case "name": {
        const binding = context.values.get(expr.name);
        if (!binding) return yield* fail(`Unknown value: ${expr.name}`);
        yield* facts.reference(binding, expr.span);
        return code.ref(binding);
      }
      case "record": {
        const fields: { name: string; value: Value<Type> }[] = [];
        const types = new Map<string, Type>();
        for (const field of expr.fields) {
          if (types.has(field.name.name))
            return yield* fail(`Duplicate field: ${field.name.name}`).at(field.name.span);
          const value = yield* elaborate(field.value, context);
          fields.push({ name: field.name.name, value });
          types.set(field.name.name, value.type);
        }
        return code.record(record(row(types)), fields);
      }
      case "field": {
        const value = yield* elaborate(expr.record, context);
        if (value.type.kind !== "record")
          return yield* fail(`Expected a record, found ${show(value.type)}`);
        const type = value.type.row.fields.get(expr.name.name);
        if (!type)
          return yield* fail(
            `Unknown field: ${expr.name.name}; fields of an abstract row cannot be projected`,
          ).at(expr.name.span);
        return code.field(type, value, expr.name.name);
      }
      case "binary": {
        const left = yield* elaborate(expr.left, context),
          right = yield* elaborate(expr.right, context);
        if (expr.op === "++") {
          if (left.type.kind !== "record" || right.type.kind !== "record")
            return yield* fail("Record concatenation requires two records");
          return code.merge(
            record(yield* concat(left.type.row, right.type.row, context.constraints)),
            left,
            right,
          );
        }
        if (expr.op === "==") {
          if (!["number", "boolean", "string"].includes(left.type.kind))
            return yield* fail("Equality is supported only for primitive values");
          yield* expect(right.type, left.type).at(expr.right.span).recover();
          return code.binary(boolean, expr.op, left, right);
        }
        yield* expect(left.type, number).at(expr.left.span).recover();
        yield* expect(right.type, number).at(expr.right.span).recover();
        return code.binary(expr.op === ">" ? boolean : number, expr.op, left, right);
      }
      case "call": {
        const callee = yield* elaborate(expr.fn, context);
        if (callee.type.kind !== "function")
          return yield* fail(`Expected a function, found ${show(callee.type)}`);
        const args: Value<Type>[] = [];
        for (const arg of expr.args) args.push(yield* elaborate(arg, context));
        let typeArgs: Type[] | undefined;
        if (expr.typeArgs) {
          if (expr.typeArgs.length !== callee.type.generics.length)
            return yield* fail(
              `Expected ${callee.type.generics.length} type arguments, found ${expr.typeArgs.length}`,
            );
          typeArgs = [];
          for (let i = 0; i < expr.typeArgs.length; i++)
            typeArgs.push(
              yield* resolveConstructor(
                expr.typeArgs[i]!,
                context.types,
                context.constraints,
                callee.type.generics[i]!.typeKind,
              ),
            );
        }
        const result = yield* apply(
          callee.type,
          args.map((a) => a.type),
          context.constraints,
          typeArgs,
        );
        let value = callee;
        if (!args.length) return code.call(result, callee, code.record(record(row()), []));
        for (let i = 0; i < args.length; i++)
          value = code.call(
            i === args.length - 1
              ? result
              : fn(
                  args.slice(i + 1).map((a) => a.type),
                  result,
                ),
            value,
            args[i]!,
          );
        return value;
      }
      case "lambda": {
        const params = yield* parameters(expr.params, context);
        let inner = context;
        for (const p of params) inner = withValue(inner, p);
        const body = yield* elaborateBody(expr.body, inner);
        return yield* lambda(
          params,
          body,
          fn(
            params.map((p) => p.type),
            body.result.type,
          ),
        );
      }
      case "let":
        return yield* code.scope(function* () {
            const value = yield* elaborate(expr.value, context);
            if (expr.annotation)
              yield* expect(
                value.type,
                yield* resolve(expr.annotation, context.types, context.constraints),
              );
            const ref = yield* code.declare(expr.name.name, value);
            yield* facts.define(
              ref.node.binding,
              expr.name.span,
              value.type.kind === "function" ? "function" : "variable",
            );
            return yield* elaborate(expr.body, withValue(context, ref.node.binding));
          });
      case "if": {
        const cond = yield* elaborate(expr.cond, context);
        yield* expect(cond.type, boolean);
        const then = yield* code.body(function* () {
          return yield* elaborate(expr.then, context);
        });
        const otherwise = yield* code.body(function* () {
          return yield* elaborate(expr.else, context);
        });
        yield* expect(otherwise.result.type, then.result.type);
        return code.conditional(then.result.type, cond, then, otherwise);
      }
    }
  })
    .flatMap((value) =>
      check(function* () {
        yield* facts.typed(value.type, expr.span);
        return code.at(value, expr.span);
      }),
    )
    .at(expr.span);

export const elaborateBody = (expr: Expr, context: Context): Check<Body<Type>> =>
  code.body(function* () {
    return yield* elaborate(expr, context);
  });

const declaration = (
  decl: Exclude<Declaration, { kind: "type" }>,
  context: Context,
): Check<Value<Type>> =>
  check(function* () {
    if (decl.kind === "let") {
      const value = yield* elaborate(decl.value, context);
      if (decl.annotation)
        yield* expect(
          value.type,
          yield* resolve(decl.annotation, context.types, context.constraints),
        );
      return value;
    }
    const { scope: types, parameters: generics } = yield* bindGenerics(
      decl.generics,
      context.types,
    );
    const constraints: Constraint[] = [];
    for (const c of decl.constraints) {
      const left = yield* resolveConstraintRow(c.left, types, constraints),
        right = yield* resolveConstraintRow(c.right, types, constraints);
      const constraint = { left, right };
      yield* disjoint(left, right, [constraint]).at(c.span);
      constraints.push(constraint);
    }
    let inner: Context = { values: context.values, types, constraints };
    const params = yield* parameters(decl.params, inner);
    if (!decl.result && decl.body.kind !== "block")
      return yield* fail("Expression-bodied functions require a return type annotation");
    const result = decl.result ? yield* resolve(decl.result, types, constraints) : record(row());
    for (const p of params) inner = withValue(inner, p);
    const body = yield* elaborateBody(decl.body, inner);
    yield* expect(body.result.type, result).at(decl.body.span);
    return yield* lambda(
      params,
      body,
      fn(
        params.map((p) => p.type),
        result,
        generics,
        constraints,
      ),
    );
  })
    .at(decl.span)
    .context(decl.name.name);

export const build = (declarations: readonly Declaration[], entry: boolean): Check<Body<Type>> =>
  code.body(function* () {
      const parameter: Parameter = { id: Symbol("A"), name: "A", typeKind };
      const valueType: Type = { kind: "variable", parameter };
      const printed = code.binding("value", valueType);
      const unit = record(row());
      const printBody = yield* code.body(function* () {
        return code.print(unit, code.ref(printed));
      });
      const print = yield* code.declare(
        "print",
        code.fn(fn([valueType], unit, [parameter]), printed, printBody),
      );
      let context = withValue(empty, print.node.binding);

      const left = code.binding("left", string),
        right = code.binding("right", string);
      const concatBody = yield* code.body(function* () {
        return code.binary(string, "+", code.ref(left), code.ref(right));
      });
      const textConcat = yield* code.declare(
        "textConcat",
        yield* lambda([left, right], concatBody, fn([string, string], string)),
      );
      context = withValue(context, textConcat.node.binding);

      const F: Parameter = { id: Symbol("F"), name: "F", typeKind: arrowKind(typeKind, typeKind) };
      const R: Parameter = { id: Symbol("R"), name: "R", typeKind: rowKind() };
      const S: Parameter = { id: Symbol("S"), name: "S", typeKind };
      const A: Parameter = { id: Symbol("A"), name: "A", typeKind };
      const source = row(new Map(), [{ base: variable(R), mapper: undefined }]);
      const mapped = yield* mapRow(variable(F), source, []);
      const fieldMetadata: Type = {
        kind: "application",
        fn: variable(F),
        arg: variable(A),
        typeKind,
      };
      const stepType = fn([variable(S), fieldMetadata, variable(A)], variable(S), [A]);
      const foldType = fn(
        [folder(source), record(mapped), record(source), variable(S), stepType],
        variable(S),
        [F, R, S],
      );
      const foldParams = foldType.params.map((type, i) =>
        code.binding(["order", "metadata", "values", "initial", "step"][i]!, type),
      );
      const [order, metadata, values, initial, step] = foldParams.map((param) => code.ref(param));
      const foldBody = yield* code.body(function* () {
        return code.recordFold(variable(S), order!, metadata!, values!, initial!, step!);
      });
      const foldRecord = yield* code.declare(
        "foldRecord",
        yield* lambda(foldParams, foldBody, foldType),
      );
      context = withValue(context, foldRecord.node.binding);
      const declared = new Set<string>();
      const declaredTypes = new Set<string>();
      for (const decl of declarations) {
        if (decl.kind === "type") {
          if (
            declaredTypes.has(decl.name.name) ||
            ["number", "boolean", "string"].includes(decl.name.name)
          )
            return yield* fail(`Duplicate or reserved type declaration: ${decl.name.name}`).at(
              decl.name.span,
            );
          const { scope, parameters } = yield* bindGenerics(decl.generics, context.types);
          const body = yield* resolveConstructor(decl.body, scope, [], decl.resultKind ?? typeKind);
          const value = alias(parameters, body);
          context = { ...context, types: new Map(context.types).set(decl.name.name, value) };
          declaredTypes.add(decl.name.name);
          continue;
        }
        if (declared.has(decl.name.name))
          return yield* fail(`Duplicate declaration: ${decl.name.name}`).at(decl.name.span);
        declared.add(decl.name.name);
        const value = yield* declaration(decl, context);
        const ref = yield* code.declare(decl.name.name, value);
        yield* facts.define(
          ref.node.binding,
          decl.name.span,
          value.type.kind === "function" ? "function" : "variable",
        );
        context = withValue(context, ref.node.binding);
      }
      const main = context.values.get("main");
      if (!main && entry) return yield* fail("Missing entry value: main");
      if (
        main &&
        declarations.some((decl) => decl.kind === "function" && decl.name.name === "main")
      ) {
        const type = main.type;
        if (type.kind !== "function" || type.params.length || type.generics.length)
          return yield* fail(
            "Function entry main must have no parameters or generic parameters",
          ).at(declarations.find((decl) => decl.name.name === "main")!.span);
        const result = yield* apply(type, [], []);
        return code.call(result, code.ref(main), code.record(unit, []));
      }
      return main ? code.ref(main) : code.record(unit, []);
  });

const parse = (source: string): Result<readonly Declaration[]> => {
  const parsed = program.parse(source);
  if (parsed.success) return parsed;
  const diagnostic = parsed.error.diagnostic;
  const errors: [Diagnostic, ...Diagnostic[]] = [{
    ...diagnostic,
    message: parsed.error.message,
    context: ["parsing", ...(diagnostic.context ?? [])],
  }];
  return { success: false, errors };
};

export type Compiled = {
  readonly type: Type;
  readonly ir: Program<Type>;
  readonly javascript: string;
  readonly entry: "value" | "function";
};

export const compile = (source: string): Result<Compiled> => {
  const parsed = parse(source);
  if (!parsed.success) return parsed;
  const built = run(build(parsed.value, true));
  if (!built.success) return built;
  const ir = code.program(built.value);
  return {
    success: true,
    value: {
      type: built.value.result.type,
      ir,
      javascript: javascript.emit(ir),
      entry: parsed.value.some((decl) => decl.kind === "function" && decl.name.name === "main")
        ? "function"
        : "value",
    },
  };
};

export const analyze = (source: string): Analysis<Type> => {
  const lexical = highlight(source, tokens),
    parsed = parse(source);
  if (!parsed.success)
    return {
      diagnostics: [...parsed.errors],
      types: [],
      definitions: [],
      references: [],
      tokens: lexical,
    };
  return facts.collect(build(parsed.value, false), lexical).analysis;
};

if (import.meta.main) {
  const file = process.argv[2] ?? new URL("./main.ur", import.meta.url);
  try {
    const source = readFileSync(file, "utf8"),
      result = compile(source);
    if (!result.success) {
      for (const error of result.errors) console.error(render(error, source));
      process.exitCode = 1;
    } else {
      const value = runInNewContext(
        result.value.javascript,
        { console: { log: (...values: unknown[]) => console.log(...values) } },
        { timeout: 1000 },
      );
      if (result.value.entry === "value") console.log(value);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
