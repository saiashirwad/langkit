import {
  bind,
  type Check,
  check,
  type Diagnostic,
  fail,
  get,
  lookup,
  render,
  type Result,
  run,
  scoped,
  type Span,
  within,
} from "langkit";
import { type Analysis, create as createAnalysis, highlight, unanalyzed } from "langkit/analysis";
import { type Binding, type Body, create, type Program, type Value } from "langkit/ir";
import { elaboration } from "langkit/ir/check";
import { createJavaScriptEmitter } from "langkit/javascript";
import { coreJavaScript } from "langkit/javascript/core";
import { printingJavaScript } from "langkit/javascript/printing";
import { recordsJavaScript } from "langkit/javascript/records";
import { variantsJavaScript } from "langkit/javascript/variants";
import { loadModules, type ModuleGraph, type ModuleOptions } from "langkit/modules";
import { parseImports } from "langkit/modules/imports";
import { printing } from "langkit/operations/printing";
import { records } from "langkit/operations/records";
import { variants } from "langkit/operations/variants";
import { parseResult } from "langkit/parse";
import {
  boolean,
  data,
  exclude,
  expectFunction,
  flatten,
  fn,
  forall,
  fresh,
  freshRow,
  generalize,
  generic,
  instantiate,
  instantiateForall,
  mono,
  number,
  prune,
  record,
  row,
  type Scheme,
  skolemize,
  string,
  subsume,
  type Type,
  type TypeConstructor,
  unify,
} from "langkit/types/higher-rank";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { type DataDecl, type Expr, type Module, program, tokens, type TypeExpr } from "./advanced-syntax.ts";

export { show, type Type } from "langkit/types/higher-rank";
export { program } from "./advanced-syntax.ts";
export type { Expr } from "./advanced-syntax.ts";

type Entry = { readonly binding: Binding<Type>; readonly scheme: Scheme; };

type Constructor = {
  readonly binding: Binding<Type>;
  readonly type: Type;
  readonly arity: number;
  readonly tag: string;
  readonly owner: TypeConstructor;
};

type Definition = { readonly type: TypeConstructor; readonly constructors: readonly string[]; };

const recordFeature = records<Type>();
const variantFeature = variants<Type>();
const printingFeature = printing<Type>();
const pureCode = create<Type>().use(recordFeature).use(variantFeature).use(printingFeature);
const code = elaboration(pureCode);
const javascript = createJavaScriptEmitter<Type>(
  coreJavaScript(pureCode.coreDescriptors),
  recordsJavaScript(recordFeature.descriptors),
  variantsJavaScript(variantFeature.descriptors),
  printingJavaScript(printingFeature.descriptors),
);
const facts = createAnalysis<Type>();
const env = scoped<ReadonlyMap<string, Entry>>(new Map());
const definitions = scoped<ReadonlyMap<string, Definition>>(new Map());
const constructors = scoped<ReadonlyMap<string, Constructor>>(new Map());
const level = scoped(0);

const resolve = (
  syntax: TypeExpr,
  parameters: ReadonlyMap<string, Type> = new Map(),
): Check<Type> =>
  check(function*() {
    switch (syntax.kind) {
      case "name": {
        const parameter = parameters.get(syntax.name);
        const primitive = syntax.name === "number"
          ? number
          : syntax.name === "boolean"
          ? boolean
          : syntax.name === "string"
          ? string
          : undefined;
        if (parameter || primitive) {
          if (syntax.args.length) return yield* fail(`Type ${syntax.name} takes no arguments`);
          return (parameter ?? primitive)!;
        }
        const definition = (yield* get(definitions)).get(syntax.name);
        if (!definition) return yield* fail(`Unknown type: ${syntax.name}`);
        if (syntax.args.length !== definition.type.arity) {
          return yield* fail(
            `Type ${syntax.name} expects ${definition.type.arity} arguments, found ${syntax.args.length}`,
          );
        }
        const args: Type[] = [];
        for (const arg of syntax.args) {
          const type = yield* resolve(arg, parameters);
          if (prune(type).kind === "forall") {
            return yield* fail("Polymorphic data arguments are not supported");
          }
          args.push(type);
        }
        return data(definition.type, args);
      }
      case "function":
        return fn(
          yield* resolve(syntax.param, parameters),
          yield* resolve(syntax.result, parameters),
        );
      case "record": {
        const fields = new Map<string, Type>();
        for (const field of syntax.fields) {
          if (fields.has(field.name)) return yield* fail(`Duplicate field: ${field.name}`);
          const type = yield* resolve(field.type, parameters);
          if (prune(type).kind === "forall") {
            return yield* fail("Polymorphic record fields are not supported");
          }
          fields.set(field.name, type);
        }
        return record(row(fields));
      }
      case "forall": {
        if (new Set(syntax.parameters).size !== syntax.parameters.length) {
          return yield* fail("Duplicate forall parameter");
        }
        const variables = syntax.parameters.map(generic);
        const nested = new Map(parameters);
        for (const variable of variables) nested.set(variable.name, variable);
        return forall(variables, yield* resolve(syntax.body, nested));
      }
    }
  }).at(syntax.span);

const typed = (expr: Expr, computation: Check<Value<Type>>): Check<Value<Type>> =>
  computation
    .flatMap((value) =>
      check(function*() {
        yield* facts.typed(value.type, expr.span);
        return code.at(value, expr.span);
      })
    )
    .at(expr.span);

const checkExpr = (expr: Expr, expected: Type): Check<Value<Type>> =>
  typed(
    expr,
    check(function*() {
      const target = prune(expected);
      const current = yield* get(level);
      if (target.kind === "forall") {
        const value = yield* within(
          level,
          () => current + 1,
          checkExpr(expr, yield* skolemize(target, current + 1)),
        );
        return { ...value, type: expected };
      }
      if (expr.kind === "fn" && target.kind === "function") {
        const parameter = expr.annotation ? yield* resolve(expr.annotation) : target.param;
        if (expr.annotation) yield* subsume(target.param, parameter, current);
        const binding = code.binding(expr.param, parameter);
        yield* facts.define(binding, expr.paramSpan, "parameter");
        const body = yield* code.body(bind(
          env,
          [[expr.param, { binding, scheme: mono(parameter) }]],
          checkExpr(expr.body, target.result),
        ));
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
      const value = yield* elaborate(expr);
      yield* subsume(value.type, expected, current);
      return { ...value, type: expected };
    }),
  );

const elaborateLet = (expr: Extract<Expr, { kind: "let"; }>, expected?: Type): Check<Value<Type>> =>
  code.scope(function*() {
    const environment = yield* get(env);
    const annotation = expr.annotation ? yield* resolve(expr.annotation) : undefined;
    let binding: Binding<Type>;
    let scheme: Scheme;
    if (expr.recursive) {
      if (expr.value.kind !== "fn") {
        return yield* fail("Recursive bindings require a function initializer");
      }
      const type = annotation ?? (yield* fresh(yield* get(level)));
      binding = code.binding(expr.name, type);
      const initial = yield* bind(
        env,
        [[expr.name, { binding, scheme: mono(type) }]],
        checkExpr(expr.value, type),
      );
      yield* code.declareRecursive(binding, initial);
      scheme = annotation
        ? mono(annotation)
        : yield* generalize(type, [...environment.values()].map((entry) => entry.scheme));
    } else {
      const initial = annotation
        ? yield* checkExpr(expr.value, annotation)
        : yield* elaborate(expr.value);
      const value = yield* code.declare(expr.name, initial);
      binding = value.node.binding;
      scheme = annotation
        ? mono(annotation)
        : yield* generalize(initial.type, [...environment.values()].map((entry) => entry.scheme));
    }
    yield* facts.define(
      binding,
      expr.nameSpan,
      ["function", "forall"].includes(prune(binding.type).kind) ? "function" : "variable",
    );
    return yield* bind(
      env,
      [[expr.name, { binding, scheme }]],
      expected ? checkExpr(expr.body, expected) : elaborate(expr.body),
    );
  });

const elaborateMatch = (
  expr: Extract<Expr, { kind: "match"; }>,
  expected?: Type,
): Check<Value<Type>> =>
  check(function*() {
    const value = yield* elaborate(expr.value);
    const current = yield* get(level);
    const result = expected ?? (yield* fresh(current));
    const known = yield* get(constructors);
    const seen = new Set<string>();
    const cases: { tag: string; bindings: Binding<Type>[]; body: Body<Type>; }[] = [];
    let fallback: { binding?: Binding<Type>; body: Body<Type>; } | undefined;
    if (!expr.cases.length) return yield* fail("Match requires at least one case");
    for (const branch of expr.cases) {
      if (fallback) return yield* fail("Unreachable case after catch-all").at(branch.span);
      const pattern = branch.pattern;
      if (pattern.kind === "binding") {
        if (pattern.name === "_") {
          fallback = {
            body: yield* code.body(checkExpr(branch.body, result)),
          };
        } else {
          const binding = code.binding(pattern.name, value.type);
          yield* facts.define(binding, pattern.span);
          const body = yield* code.body(bind(
            env,
            [[pattern.name, { binding, scheme: mono(value.type) }]],
            checkExpr(branch.body, result),
          ));
          fallback = { binding, body };
        }
        continue;
      }
      const constructor = known.get(pattern.name);
      if (!constructor) return yield* fail(`Unknown constructor: ${pattern.name}`).at(pattern.span);
      if (seen.has(constructor.tag)) {
        return yield* fail(`Unreachable duplicate case: ${pattern.name}`).at(pattern.span);
      }
      seen.add(constructor.tag);
      if (pattern.fields.length !== constructor.arity) {
        return yield* fail(
          `Constructor ${pattern.name} expects ${constructor.arity} fields, found ${pattern.fields.length}`,
        ).at(pattern.span);
      }
      yield* facts.reference(constructor.binding, {
        start: pattern.span.start,
        end: pattern.span.start + pattern.name.length,
      });
      let type = yield* instantiateForall(constructor.type, current);
      const bindings: Binding<Type>[] = [];
      const entries = new Map<string, Entry>();
      for (const field of pattern.fields) {
        const arrow = prune(type);
        if (arrow.kind !== "function") throw new Error("Constructor arity does not match its type");
        const binding = code.binding(field.name, arrow.param);
        bindings.push(binding);
        if (field.name !== "_") {
          if (entries.has(field.name)) {
            return yield* fail(`Duplicate pattern binding: ${field.name}`).at(field.span);
          }
          entries.set(field.name, { binding, scheme: mono(arrow.param) });
          yield* facts.define(binding, field.span);
        }
        type = arrow.result;
      }
      yield* unify(value.type, type).at(pattern.span);
      const body = yield* code.body(bind(env, entries, checkExpr(branch.body, result)));
      cases.push({ tag: constructor.tag, bindings, body });
    }
    if (!fallback) {
      const type = prune(value.type);
      if (type.kind !== "data") return yield* fail("Constructor match requires a data type");
      const definition = [...(yield* get(definitions)).values()].find(
        (def) => def.type.id === type.constructor.id,
      )!;
      const missing = definition.constructors.filter((name) => !seen.has(known.get(name)!.tag));
      if (missing.length) {
        return yield* fail(`Non-exhaustive match; missing: ${missing.join(", ")}`);
      }
    }
    return code.match(result, value, cases, fallback);
  }).at(expr.span);

export const elaborate = (expr: Expr): Check<Value<Type>> =>
  typed(
    expr,
    check(function*() {
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
          yield* facts.reference(binding, expr.span);
          return code.ref(binding, yield* instantiateForall(yield* instantiate(scheme, current), current));
        }
        case "record": {
          const fields: { name: string; value: Value<Type>; }[] = [];
          const types = new Map<string, Type>();
          for (const field of expr.fields) {
            if (types.has(field.name)) return yield* fail(`Duplicate field: ${field.name}`);
            const value = yield* elaborate(field.value);
            if (prune(value.type).kind === "forall") {
              return yield* fail("Polymorphic record fields are not supported");
            }
            fields.push({ name: field.name, value });
            types.set(field.name, value.type);
          }
          if (!expr.base) return code.record(record(row(types)), fields);
          const base = yield* elaborate(expr.base);
          const tail = yield* freshRow([], current);
          yield* unify(base.type, record(row(new Map(), tail))).at(expr.base.span);
          yield* exclude(row(new Map(), tail), types.keys()).at(expr.base.span);
          return code.record(record(row(types, tail)), fields, base);
        }
        case "field": {
          const value = yield* elaborate(expr.record);
          const type = yield* fresh(current);
          yield* unify(
            value.type,
            record(row(new Map([[expr.name, type]]), yield* freshRow([expr.name], current))),
          );
          return code.field(type, value, expr.name);
        }
        case "binary": {
          const left = yield* elaborate(expr.left);
          const right = yield* elaborate(expr.right);
          yield* subsume(left.type, number, current).at(expr.left.span).recover();
          yield* subsume(right.type, number, current).at(expr.right.span).recover();
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
          const type = expr.annotation ? yield* resolve(expr.annotation) : yield* fresh(current);
          const binding = code.binding(expr.param, type);
          yield* facts.define(binding, expr.paramSpan, "parameter");
          const body = yield* code.body(
            bind(env, [[expr.param, { binding, scheme: mono(type) }]], elaborate(expr.body)),
          );
          return code.fn(fn(type, body.result.type), binding, body);
        }
        case "call": {
          const callee = yield* elaborate(expr.fn);
          const type = yield* expectFunction(callee.type, current).at(expr.fn.span);
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
          return yield* checkExpr(expr.value, yield* resolve(expr.annotation));
        case "match":
          return yield* elaborateMatch(expr);
      }
    }),
  );
export const elaborateBody = (expr: Expr): Check<Body<Type>> => code.body(elaborate(expr));
const withTypes = <A>(declarations: readonly DataDecl[], body: Check<A>): Check<A> =>
  code.check(function*() {
    const existing = yield* get(definitions);
    const added = new Map<string, Definition>();
    for (const declaration of declarations) {
      if (
        existing.has(declaration.name)
        || added.has(declaration.name)
        || ["number", "boolean", "string"].includes(declaration.name)
      ) {
        return yield* fail(`Duplicate type: ${declaration.name}`).at(declaration.nameSpan);
      }
      if (new Set(declaration.parameters).size !== declaration.parameters.length) {
        return yield* fail(`Duplicate type parameter in ${declaration.name}`).at(declaration.span);
      }
      if (!declaration.constructors.length) {
        return yield* fail("Data type requires a constructor").at(declaration.span);
      }
      added.set(declaration.name, {
        type: {
          id: Symbol(declaration.name),
          name: declaration.name,
          arity: declaration.parameters.length,
        },
        constructors: declaration.constructors.map((constructor) => constructor.name),
      });
    }
    return yield* bind(
      definitions,
      added,
      code.check(function*() {
        const known = yield* get(constructors);
        const addedConstructors = new Map<string, Constructor>();
        const entries = new Map<string, Entry>();
        for (const declaration of declarations) {
          const owner = added.get(declaration.name)!.type;
          const variables = declaration.parameters.map(generic);
          const parameters = new Map<string, Type>(
            variables.map((variable) => [variable.name, variable]),
          );
          const result = data(owner, variables);
          for (const syntax of declaration.constructors) {
            if (!/^[A-Z]/.test(syntax.name)) {
              return yield* fail("Constructor names must start with an uppercase letter").at(
                syntax.nameSpan,
              );
            }
            if (known.has(syntax.name) || addedConstructors.has(syntax.name)) {
              return yield* fail(`Duplicate constructor: ${syntax.name}`).at(syntax.nameSpan);
            }
            const fields: Binding<Type>[] = [];
            for (const field of syntax.fields) {
              const type = yield* resolve(field, parameters);
              if (prune(type).kind === "forall") {
                return yield* fail("Polymorphic constructor fields are not supported").at(
                  field.span,
                );
              }
              fields.push(code.binding("field", type));
            }
            const tag = `${owner.name}.${syntax.name}`;
            let initial = code.variant(
              result,
              tag,
              fields.map((field) => code.ref(field)),
            );
            for (const field of fields.toReversed()) {
              initial = code.fn(
                fn(field.type, initial.type),
                field,
                pureCode.body(function*() {
                  return initial;
                }),
              );
            }
            const type = variables.length ? forall(variables, initial.type) : initial.type;
            const value = yield* code.declare(syntax.name, { ...initial, type });
            const binding = value.node.binding;
            yield* facts.define(
              binding,
              syntax.nameSpan,
              fields.length ? "function" : "variable",
            );
            addedConstructors.set(syntax.name, { binding, type, arity: fields.length, tag, owner });
            entries.set(syntax.name, { binding, scheme: mono(type) });
          }
        }
        return yield* bind(constructors, addedConstructors, bind(env, entries, body));
      }),
    );
  });

export type Checked = {
  readonly type: Type;
  readonly body: Body<Type>;
  readonly syntax: Module;
  readonly datatypes: ReadonlyMap<string, string>;
};
export type Compiled = Checked & { readonly ir: Program<Type>; readonly javascript: string; };

type Root = Pick<Checked, "syntax" | "datatypes">;

const parse = (source: string): Result<Module> => parseResult(program, source);

type Origin = { readonly uri: string; readonly span: Span; readonly name: string; };

type Export = Entry & { readonly identity: symbol; readonly origin: Origin; };

type ModuleExports = {
  readonly values: ReadonlyMap<string, Export>;
  readonly definitions: ReadonlyMap<string, Definition>;
  readonly constructors: ReadonlyMap<string, Constructor>;
};

const exportOrigins = (expr: Expr): Map<string, Span> => {
  const locals = new Map<string, Span>();
  while (expr.kind === "let") {
    locals.set(expr.name, expr.nameSpan);
    expr = expr.body;
  }
  const result = new Map<string, Span>();
  if (expr.kind === "record") {
    for (const field of expr.fields) {
      const local = field.value.kind === "name" ? locals.get(field.value.name) : undefined;
      result.set(field.name, local ?? field.nameSpan);
    }
  }
  return result;
};

const buildModules = (
  graph: ModuleGraph,
  external: Map<symbol, Export>,
  expose: (root: Root) => void = () => {},
): Check<Body<Type>> =>
  code.body(function*() {
    const param = code.binding("value", yield* fresh());
    const unit = record(row());
    const printed = yield* code.declare(
      "print",
      code.fn(
        fn(param.type, unit),
        param,
        pureCode.body(function*() {
          return code.print(unit, code.ref(param));
        }),
      ),
    );
    const primitive: Entry = {
      binding: printed.node.binding,
      scheme: yield* generalize(printed.type, []),
    };
    const completed = new Map<string, ModuleExports>();
    const declaredIn = new Map<symbol, string>();
    for (const module of graph.modules) {
      const imported = new Map<string, Export>();
      const importedDefinitions = new Map<string, Definition>();
      const importedConstructors = new Map<string, Constructor>();
      for (const dependency of module.imports) {
        const exports = completed.get(dependency.uri)!;
        for (const [name, entry] of exports.values) {
          const previous = imported.get(name);
          if (previous && previous.identity !== entry.identity) {
            return yield* fail(`Conflicting imported name: ${name}`)
              .at(dependency.span)
              .inDocument(module.uri);
          }
          imported.set(name, entry);
        }
        for (const [name, definition] of exports.definitions) {
          const previous = importedDefinitions.get(name);
          if (previous && previous.type.id !== definition.type.id) {
            return yield* fail(`Conflicting imported type: ${name}`)
              .at(dependency.span)
              .inDocument(module.uri);
          }
          importedDefinitions.set(name, definition);
        }
        for (const [name, constructor] of exports.constructors) {
          importedConstructors.set(name, constructor);
        }
      }
      const environment = new Map<string, Entry>([["print", primitive], ...imported]);
      const parsed = parse(module.source);
      if (!parsed.success) {
        return yield* fail(parsed.errors[0].message).at(parsed.errors[0].span).inDocument(module.uri);
      }
      const inEnvironment = <A>(body: Check<A>): Check<A> =>
        within(
          env,
          () => environment,
          within(
            definitions,
            () => importedDefinitions,
            within(constructors, () => importedConstructors, body),
          ),
        );
      if (module.uri === graph.root) {
        for (const entry of imported.values()) external.set(entry.binding.id, entry);
        expose({
          syntax: parsed.value,
          datatypes: new Map([
            ...[...importedDefinitions].map(([name, definition]) =>
              [name, declaredIn.get(definition.type.id)!] as const
            ),
            ...parsed.value.types.map((type) => [type.name, module.uri] as const),
          ]),
        });
        return yield* inEnvironment(withTypes(parsed.value.types, elaborate(parsed.value.body))).inDocument(module.uri);
      }
      let moduleDefinitions: ReadonlyMap<string, Definition> = new Map();
      let moduleConstructors: ReadonlyMap<string, Constructor> = new Map();
      const ownConstructors = new Map(
        parsed.value.types.flatMap((type) =>
          type.constructors.map(
            (constructor) => [constructor.name, constructor.nameSpan] as const,
          )
        ),
      );
      const bundled = yield* facts.ignore(
        inEnvironment(
          code.scope(function*() {
            const initial = yield* withTypes(
              parsed.value.types,
              code.check(function*() {
                const value = yield* elaborate(parsed.value.body);
                moduleDefinitions = yield* get(definitions);
                moduleConstructors = yield* get(constructors);
                return value;
              }),
            );
            if (prune(initial.type).kind !== "record") {
              return yield* fail(`Imported module must return a record: ${module.uri}`).at(parsed.value.body.span);
            }
            const result = yield* code.declare("exports", initial);
            const fields = [{ name: "@values", value: result as Value<Type> }];
            for (const name of ownConstructors.keys()) {
              fields.push({ name: `@${name}`, value: code.ref(moduleConstructors.get(name)!.binding) });
            }
            return code.record(
              record(row(new Map(fields.map((field) => [field.name, field.value.type])))),
              fields,
            );
          }),
        ),
      ).inDocument(module.uri);
      const bundle = yield* code.declare("module", bundled);
      const bundledType = prune(bundle.type);
      if (bundledType.kind !== "record") throw new Error("Expected module bundle");
      const resultType = flatten(bundledType.row).fields.get("@values")!;
      const type = prune(resultType);
      if (type.kind !== "record") throw new Error("Expected record exports");
      const result = code.field(resultType, bundle, "@values");
      const entries = new Map(imported);
      const constructorEntries = new Map(importedConstructors);
      for (const [name, span] of ownConstructors) {
        if (entries.has(name)) {
          return yield* fail(`Conflicting exported name: ${name}`).at(span).inDocument(module.uri);
        }
        const original = moduleConstructors.get(name)!;
        const value = yield* code.declare(name, code.field(original.type, bundle, `@${name}`));
        const binding = value.node.binding;
        entries.set(name, {
          binding,
          scheme: mono(original.type),
          identity: original.binding.id,
          origin: { uri: module.uri, name, span },
        });
        constructorEntries.set(name, { ...original, binding });
      }
      for (const type of parsed.value.types) declaredIn.set(moduleDefinitions.get(type.name)!.type.id, module.uri);
      const origins = exportOrigins(parsed.value.body);
      for (const [name, fieldType] of flatten(type.row).fields) {
        if (entries.has(name)) {
          return yield* fail(`Conflicting exported name: ${name}`)
            .at(origins.get(name) ?? parsed.value.body.span)
            .inDocument(module.uri);
        }
        const reference = yield* code.declare(name, code.field(fieldType, result, name));
        entries.set(name, {
          binding: reference.node.binding,
          scheme: yield* generalize(fieldType, [...environment.values()].map((entry) => entry.scheme)),
          identity: Symbol(name),
          origin: { uri: module.uri, name, span: origins.get(name) ?? parsed.value.body.span },
        });
      }
      completed.set(module.uri, {
        values: entries,
        definitions: moduleDefinitions,
        constructors: constructorEntries,
      });
    }
    throw new Error("Module graph has no root");
  });

export const analyze = (source: string, options: ModuleOptions = {}): Analysis<Type> => {
  const graph = loadModules(source, options, { extension: "advanced", imports: parseImports });
  const lexical = highlight(source, tokens);
  if (!graph.success) return unanalyzed(graph.errors, lexical);
  const external = new Map<symbol, Export>();
  const analysis = facts.collect(buildModules(graph.value, external), lexical).analysis;
  const referenced = new Set(analysis.references.map((reference) => reference.id));
  return {
    ...analysis,
    diagnostics: analysis.diagnostics.map((error) => graph.value.routeDiagnostic(error)),
    sources: graph.value.sources,
    dependencyUris: graph.value.dependencyUris,
    definitions: [
      ...analysis.definitions,
      ...[...external.values()]
        .filter((entry) => referenced.has(entry.binding.id))
        .map((entry) => ({
          ...entry.binding,
          span: entry.origin.span,
          uri: entry.origin.uri,
          kind: ["function", "forall"].includes(prune(entry.scheme.type).kind)
            ? ("function" as const)
            : ("variable" as const),
        })),
    ],
  };
};

export const checkModule = (source: string, options: ModuleOptions = {}): Result<Checked> => {
  const graph = loadModules(source, options, { extension: "advanced", imports: parseImports });
  if (!graph.success) return graph;
  let root: Root | undefined;
  const built = run(buildModules(graph.value, new Map(), (exposed) => (root = exposed)));
  if (!built.success) {
    const errors: [Diagnostic, ...Diagnostic[]] = [graph.value.routeDiagnostic(built.errors[0])];
    for (let i = 1; i < built.errors.length; i++) {
      errors.push(graph.value.routeDiagnostic(built.errors[i]!));
    }
    return { success: false, errors };
  }
  if (!root) throw new Error("Module graph has no root");
  return { success: true, value: { type: built.value.result.type, body: built.value, ...root } };
};

export const emit = ({ body }: Checked): string => javascript.emit(code.program(body));

export const compile = (source: string, options: ModuleOptions = {}): Result<Compiled> => {
  const checked = checkModule(source, options);
  if (!checked.success) return checked;
  const ir = code.program(checked.value.body);
  return { success: true, value: { ...checked.value, ir, javascript: javascript.emit(ir) } };
};

if (import.meta.main) {
  const file = process.argv[2]
    ? pathToFileURL(resolvePath(process.argv[2]))
    : new URL("./main.advanced", import.meta.url);
  const source = readFileSync(file, "utf8");
  const result = compile(source, { uri: file.href });
  if (!result.success) {
    for (const error of result.errors) {
      const uri = error.location?.uri ?? error.origin?.uri;
      const errorSource = uri && uri !== file.href ? readFileSync(new URL(uri), "utf8") : source;
      console.error(render(error, errorSource));
    }
    process.exitCode = 1;
  } else console.log(runInNewContext(result.value.javascript, { console }, { timeout: 1000 }));
}
