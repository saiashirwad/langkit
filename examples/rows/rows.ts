import {
  between,
  choice,
  commit,
  createLexemes,
  parser,
  postfix,
  optional,
  sepBy,
  precedence,
  recursive,
  regex,
  type Parser,
} from "langkit/parse";
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
import { create, type Binding, type Body, type Operator, type Value } from "langkit/ir";
import {
  create as createAnalysis,
  highlight,
  type Analysis,
  type TokenRule,
} from "langkit/analysis";
import { createJavaScriptEmitter } from "langkit/javascript";
import { coreJavaScript } from "langkit/javascript/core";
import { records } from "langkit/operations/records";
import { printing } from "langkit/operations/printing";
import { recordsJavaScript } from "langkit/javascript/records";
import { printingJavaScript } from "langkit/javascript/printing";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadModules, type ModuleOptions, type ModuleGraph } from "langkit/modules";

// Inference belongs to this language, not the IR or the checking runner.
export type Type =
  | { readonly kind: "number" | "boolean" | "string" }
  | { readonly kind: "function"; readonly param: Type; readonly result: Type }
  | { readonly kind: "record"; readonly row: Row }
  | Variable;

type Variable = { readonly kind: "variable"; instance?: Type };

type RowVariable = { readonly kind: "row-variable"; readonly lacks: Set<string>; instance?: Row };

type Row = { readonly fields: ReadonlyMap<string, Type>; readonly tail: RowVariable | null };

type FreeVariable = Variable | RowVariable;

type Scheme = { readonly type: Type; readonly variables: ReadonlySet<FreeVariable> };

type Entry = { readonly binding: Binding<Type>; readonly scheme: Scheme };

const number: Type = { kind: "number" };
const boolean: Type = { kind: "boolean" };
const string: Type = { kind: "string" };

const fn = (param: Type, result: Type): Type => ({ kind: "function", param, result });

const record = (row: Row): Type => ({ kind: "record", row });

const row = (
  fields: ReadonlyMap<string, Type> = new Map(),
  tail: RowVariable | null = null,
): Row => ({ fields, tail });

const fresh = (): Variable => ({ kind: "variable" });

const freshRow = (lacks: Iterable<string> = []): RowVariable => ({
  kind: "row-variable",
  lacks: new Set(lacks),
});

const prune = (type: Type): Type => {
  if (type.kind !== "variable" || !type.instance) return type;
  return (type.instance = prune(type.instance));
};

const flatten = (input: Row): Row => {
  const fields = new Map(input.fields);
  let tail = input.tail;
  while (tail?.instance) {
    for (const [name, type] of tail.instance.fields) fields.set(name, type);
    tail = tail.instance.tail;
  }
  return row(fields, tail);
};

export const show = (type: Type): string => {
  const names = new Map<Variable, string>();
  const rows = new Map<RowVariable, string>();
  const visit = (type: Type): string => {
    type = prune(type);
    if (type.kind === "function") return `(${visit(type.param)} -> ${visit(type.result)})`;
    if (type.kind === "record") {
      const { fields, tail } = flatten(type.row);
      const labels = [...fields]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, type]) => `${name}: ${visit(type)}`);
      if (tail) {
        if (!rows.has(tail)) rows.set(tail, `r${rows.size || ""}`);
        return `{ ${labels.join(", ")}${labels.length ? " " : ""}| ${rows.get(tail)} }`;
      }
      return labels.length ? `{ ${labels.join(", ")} }` : "{}";
    }
    if (type.kind !== "variable") return type.kind;
    if (!names.has(type)) {
      const index = names.size;
      names.set(
        type,
        String.fromCharCode(97 + (index % 26)) + (index >= 26 ? Math.floor(index / 26) : ""),
      );
    }
    return names.get(type)!;
  };
  const result = visit(type);
  const constraints = [...rows]
    .filter(([variable]) => variable.lacks.size)
    .map(([variable, name]) => `${name} lacks ${[...variable.lacks].sort().join(", ")}`);
  return result + (constraints.length ? ` where ${constraints.join("; ")}` : "");
};

const freeRow = (input: Row, found: Set<FreeVariable>): void => {
  const { fields, tail } = flatten(input);
  for (const type of fields.values()) free(type, found);
  if (tail) found.add(tail);
};

const free = (type: Type, found = new Set<FreeVariable>()): Set<FreeVariable> => {
  type = prune(type);
  if (type.kind === "variable") found.add(type);
  else if (type.kind === "function") {
    free(type.param, found);
    free(type.result, found);
  } else if (type.kind === "record") freeRow(type.row, found);
  return found;
};

// Every row tail excludes its explicit fields. Extension adds absence constraints;
// solving a row variable checks and propagates them, including through aliases.
const exclude = (input: Row, labels: Iterable<string>): Check<void> =>
  check(function* () {
    const { fields, tail } = flatten(input);
    for (const label of labels) {
      if (fields.has(label)) return yield* fail(`Duplicate field: ${label}`);
      tail?.lacks.add(label);
    }
  });

const solveRow = (variable: RowVariable, input: Row): Check<void> =>
  check(function* () {
    const target = flatten(input);
    if (!target.fields.size && target.tail === variable) return;
    const variables = new Set<FreeVariable>();
    freeRow(target, variables);
    if (variables.has(variable)) return yield* fail("Infinite row");
    yield* exclude(target, variable.lacks);
    // Preserve the unique-label invariant even when the target is assembled by unification.
    if (target.tail) for (const label of target.fields.keys()) target.tail.lacks.add(label);
    variable.instance = target;
  });

const unifyRows = (left: Row, right: Row): Check<void> =>
  check(function* () {
    let a = flatten(left);
    let b = flatten(right);
    const unified = new Set<string>();
    while (true) {
      const common = [...a.fields].filter(([label]) => b.fields.has(label) && !unified.has(label));
      if (!common.length) break;
      for (const [label, type] of common) {
        yield* unify(type, b.fields.get(label)!);
        unified.add(label);
      }
      // A field's type may share variables with either tail. Solving it can
      // expose more common fields, whose types must agree before solving tails.
      a = flatten(left);
      b = flatten(right);
    }
    const onlyA = new Map([...a.fields].filter(([label]) => !b.fields.has(label)));
    const onlyB = new Map([...b.fields].filter(([label]) => !a.fields.has(label)));
    if ((!a.tail && onlyB.size) || (!b.tail && onlyA.size))
      return yield* fail(`Missing field: ${[...(!a.tail ? onlyB : onlyA).keys()].join(", ")}`);
    if (a.tail === b.tail) {
      if (onlyA.size || onlyB.size)
        return yield* fail("Infinite row: incompatible fields share a tail");
      return;
    }
    if (a.tail && b.tail) {
      const shared = freshRow();
      yield* solveRow(a.tail, row(onlyB, shared));
      yield* solveRow(b.tail, row(onlyA, shared));
    } else if (a.tail) yield* solveRow(a.tail, row(onlyB));
    else if (b.tail) yield* solveRow(b.tail, row(onlyA));
  });

const unify = (left: Type, right: Type): Check<void> =>
  check(function* () {
    const a = prune(left);
    const b = prune(right);
    if (a === b) return;
    if (a.kind === "variable") {
      if (free(b).has(a)) return yield* fail(`Infinite type: ${show(a)} occurs in ${show(b)}`);
      a.instance = b;
    } else if (b.kind === "variable") yield* unify(b, a);
    else if (a.kind === "function" && b.kind === "function") {
      yield* unify(a.param, b.param);
      yield* unify(a.result, b.result);
    } else if (a.kind === "record" && b.kind === "record") yield* unifyRows(a.row, b.row);
    else if (a.kind !== b.kind) return yield* fail(`Cannot unify ${show(a)} with ${show(b)}`);
  });

const mono = (type: Type): Scheme => ({ type, variables: new Set() });

const generalize = (type: Type, environment: ReadonlyMap<string, Entry>): Scheme => {
  const variables = free(type);
  for (const { scheme } of environment.values()) {
    for (const variable of free(scheme.type)) {
      if (!scheme.variables.has(variable)) variables.delete(variable);
    }
  }
  return { type, variables };
};

const instantiate = (scheme: Scheme): Type => {
  const replacements = new Map<Variable, Variable>();
  const rows = new Map<RowVariable, RowVariable>();
  const visitRow = (input: Row): Row => {
    const flat = flatten(input);
    let tail = flat.tail;
    if (tail && scheme.variables.has(tail)) {
      if (!rows.has(tail)) rows.set(tail, freshRow(tail.lacks));
      tail = rows.get(tail)!;
    }
    return row(new Map([...flat.fields].map(([name, type]) => [name, visit(type)])), tail);
  };
  const visit = (type: Type): Type => {
    type = prune(type);
    if (type.kind === "function") return fn(visit(type.param), visit(type.result));
    if (type.kind === "record") return record(visitRow(type.row));
    if (type.kind !== "variable" || !scheme.variables.has(type)) return type;
    if (!replacements.has(type)) replacements.set(type, fresh());
    return replacements.get(type)!;
  };
  return visit(scheme.type);
};

// Syntax. Source spans survive elaboration into the IR.
type Syntax =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  | {
      readonly kind: "record";
      readonly fields: readonly { name: string; nameSpan: Span; value: Expr }[];
      readonly base: Expr | undefined;
    }
  | { readonly kind: "field"; readonly record: Expr; readonly name: string }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "binary"; readonly op: Operator; readonly left: Expr; readonly right: Expr }
  | {
      readonly kind: "let";
      readonly name: string;
      readonly nameSpan: Span;
      readonly value: Expr;
      readonly body: Expr;
    }
  | {
      readonly kind: "fn";
      readonly param: string;
      readonly paramSpan: Span;
      readonly body: Expr;
    }
  | { readonly kind: "call"; readonly fn: Expr; readonly arg: Expr }
  | { readonly kind: "if"; readonly cond: Expr; readonly then: Expr; readonly else: Expr };

export type Expr = Syntax & { readonly span: Span };

const located = (p: Parser<Syntax>): Parser<Expr> =>
  p.withSpan((node, span) => ({ ...node, span }));

const words = /[a-zA-Z_]\w*/;
const digits = /\d+(?:\.\d+)?/;
const keywords = ["let", "in", "fn", "if", "then", "else", "true", "false", "import"] as const;
const reserved: ReadonlySet<string> = new Set(keywords);
const lex = createLexemes({
  trivia: regex(/\s*/),
  identifier: regex(words),
  keywords,
});
const { keyword, symbol, identifier } = lex;
const name = identifier.withSpan((name, span) => ({
  name,
  span: { start: span.start, end: span.start + name.length },
}));

// Reuse lexical patterns without requiring a successful parse for highlighting.
const strings = /"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/;

const tokens: readonly TokenRule[] = [
  { pattern: strings, kind: "string" },
  {
    pattern: words,
    kind: (text) => (reserved.has(text) ? "keyword" : "variable"),
  },
  { pattern: digits, kind: "number" },
  { pattern: /==|=>|->|[+\-*/>=]/, kind: "operator" },
];

const expression: Parser<Expr> = recursive<Expr>((expr) => {
  const binding = located(
    parser(function* () {
      yield* keyword("let");
      yield* commit();
      const id = yield* name;
      yield* symbol("=");
      const value = yield* expr;
      yield* keyword("in");
      return { kind: "let", name: id.name, nameSpan: id.span, value, body: yield* expr };
    }),
  );

  const lambda = located(
    parser(function* () {
      yield* keyword("fn");
      yield* commit();
      yield* symbol("(");
      const param = yield* name;
      yield* symbol(")");
      yield* symbol("=>");
      return {
        kind: "fn",
        param: param.name,
        paramSpan: param.span,
        body: yield* expr,
      };
    }),
  );

  const conditional = located(
    parser(function* () {
      yield* keyword("if");
      yield* commit();
      const cond = yield* expr;
      yield* keyword("then");
      const then = yield* expr;
      yield* keyword("else");
      return { kind: "if", cond, then, else: yield* expr };
    }),
  );

  const records = located(
    parser(function* () {
      yield* symbol("{");
      yield* commit();
      const fields = yield* sepBy(
        parser(function* () {
          const label = yield* name;
          yield* symbol("=");
          return { name: label.name, nameSpan: label.span, value: yield* expr };
        }),
        symbol(","),
      );
      const base = yield* optional(
        parser(function* () {
          yield* symbol("|");
          yield* commit();
          return yield* expr;
        }),
      );
      yield* symbol("}");
      return { kind: "record", fields, base };
    }),
  );

  const atom = choice(
    records,
    located(
      lex
        .token(regex(strings))
        .map((text) => ({ kind: "string", value: JSON.parse(text) as string })),
    ),
    located(
      lex
        .token(regex(new RegExp(`-?${digits.source}`)))
        .map((text) => ({ kind: "number", value: Number(text) })),
    ),
    located(keyword("true").map(() => ({ kind: "boolean", value: true }))),
    located(keyword("false").map(() => ({ kind: "boolean", value: false }))),
    name.map(({ name, span }): Expr => ({ kind: "name", name, span })),
    between(symbol("("), symbol(")"), expr),
  );

  const calls = postfix(
    atom,
    choice(
      parser(function* () {
        yield* symbol(".");
        yield* commit();
        return yield* name;
      }).map(
        ({ name, span }) =>
          (record: Expr): Expr => ({
            kind: "field",
            record,
            name,
            span: { start: record.span.start, end: span.end },
          }),
      ),
      between(symbol("("), symbol(")"), expr).withSpan(
        (arg, span) =>
          (callee: Expr): Expr => ({
            kind: "call",
            fn: callee,
            arg,
            span: { start: callee.span.start, end: span.end },
          }),
      ),
    ),
  );

  const binary = (op: Operator) => {
    return symbol(op).map(
      () =>
        (left: Expr, right: Expr): Expr => ({
          kind: "binary",
          op,
          left,
          right,
          span: { start: left.span.start, end: right.span.end },
        }),
    );
  };

  const operators = precedence(calls, [
    { associativity: "left", operators: [binary("*"), binary("/")] },
    { associativity: "left", operators: [binary("+"), binary("-")] },
    { associativity: "left", operators: [binary(">"), binary("==")] },
  ]);

  return choice(binding, lambda, conditional, operators);
});

export const program = lex.complete(expression);

// Rows explicitly selects records and printing in its IR and JavaScript backend.
const recordFeature = records<Type>();
const printingFeature = printing<Type>();
const code = create<Type>().use(recordFeature).use(printingFeature);
const javascript = createJavaScriptEmitter<Type>(
  coreJavaScript(code.coreOperationTraversals()),
  recordsJavaScript(recordFeature.operations),
  printingJavaScript(printingFeature.operations),
);
const facts = createAnalysis<Type>();
const env = scoped<ReadonlyMap<string, Entry>>(new Map());
const observe = scoped(true);

export const elaborate = (expr: Expr): Check<Value<Type>> =>
  check(function* () {
    switch (expr.kind) {
      case "number":
        if (!Number.isFinite(expr.value)) return yield* fail("Number literal is too large");
        return code.literal(number, expr.value);
      case "boolean":
        return code.literal(boolean, expr.value);
      case "string":
        return code.literal(string, expr.value);
      case "record": {
        const fields: { name: string; value: Value<Type> }[] = [];
        const types = new Map<string, Type>();
        for (const field of expr.fields) {
          if (types.has(field.name)) return yield* fail(`Duplicate field: ${field.name}`);
          const value = yield* elaborate(field.value);
          fields.push({ name: field.name, value });
          types.set(field.name, value.type);
        }
        if (!expr.base) return code.record(record(row(types)), fields);
        const base = yield* elaborate(expr.base);
        const tail = freshRow();
        yield* unify(base.type, record(row(new Map(), tail))).at(expr.base.span);
        yield* exclude(row(new Map(), tail), types.keys()).at(expr.base.span);
        return code.record(record(row(types, tail)), fields, base);
      }
      case "field": {
        const base = yield* elaborate(expr.record);
        const type = fresh();
        yield* unify(base.type, record(row(new Map([[expr.name, type]]), freshRow([expr.name]))));
        return code.field(type, base, expr.name);
      }
      case "name": {
        const { binding, scheme } = yield* lookup(env, expr.name);
        if (yield* get(observe)) yield* facts.reference(binding, expr.span);
        return code.ref(binding, instantiate(scheme));
      }
      case "binary": {
        const left = yield* elaborate(expr.left);
        const right = yield* elaborate(expr.right);
        // Equality is numeric here, avoiding type-class/qualified-type machinery.
        yield* unify(left.type, number).at(expr.left.span);
        yield* unify(right.type, number).at(expr.right.span);
        return code.binary(
          expr.op === ">" || expr.op === "==" ? boolean : number,
          expr.op,
          left,
          right,
        );
      }
      case "let":
        return yield* code.scope(
          check(function* () {
            const initial = yield* elaborate(expr.value);
            const environment = yield* get(env);
            const scheme = generalize(initial.type, environment);
            const value = yield* code.declare(expr.name, initial);
            const binding = value.node.binding;
            if (yield* get(observe))
              yield* facts.define(
                binding,
                expr.nameSpan,
                prune(binding.type).kind === "function" ? "function" : "variable",
              );
            return yield* bind(env, [[expr.name, { binding, scheme }]], elaborate(expr.body));
          }),
        );
      case "fn": {
        const param = code.binding(expr.param, fresh());
        if (yield* get(observe)) yield* facts.define(param, expr.paramSpan, "parameter");
        const entry = { binding: param, scheme: mono(param.type) };
        const body = yield* code.body(bind(env, [[expr.param, entry]], elaborate(expr.body)));
        return code.fn(fn(param.type, body.result.type), param, body);
      }
      case "call": {
        const callee = yield* elaborate(expr.fn);
        const arg = yield* elaborate(expr.arg);
        const result = fresh();
        yield* unify(callee.type, fn(arg.type, result)).at(expr.arg.span);
        return code.call(result, callee, arg);
      }
      case "if": {
        const cond = yield* elaborate(expr.cond);
        yield* unify(cond.type, boolean).at(expr.cond.span);
        const then = yield* code.body(elaborate(expr.then));
        const otherwise = yield* code.body(elaborate(expr.else));
        yield* unify(then.result.type, otherwise.result.type).at(expr.else.span);
        return code.conditional(then.result.type, cond, then, otherwise);
      }
    }
  })
    .flatMap((value) =>
      check(function* () {
        if (yield* get(observe)) yield* facts.typed(value.type, expr.span);
        return code.at(value, expr.span);
      }),
    )
    .at(expr.span);

export type Compiled = {
  readonly type: Type;
  readonly ir: Body<Type>;
  readonly javascript: string;
};

const parse = (source: string): Result<Expr> => {
  const parsed = program.parse(source);
  return parsed.success
    ? parsed
    : {
        success: false,
        error: {
          message: parsed.error.message,
          span: parsed.error.diagnostic.span,
          context: ["parsing", ...(parsed.error.diagnostic.context ?? [])],
        },
      };
};

type Origin = { readonly uri: string; readonly span: Span; readonly name: string };

type Export = Entry & { readonly identity: symbol; readonly origin: Origin };

// Locate exported record helpers without adding dependency spans to root hovers.
const exportOrigins = (expr: Expr): Map<string, Span> => {
  const locals = new Map<string, Span>();
  while (expr.kind === "let") {
    locals.set(expr.name, expr.nameSpan);
    expr = expr.body;
  }
  const result = new Map<string, Span>();
  if (expr.kind === "record")
    for (const field of expr.fields) {
      const local = field.value.kind === "name" ? locals.get(field.value.name) : undefined;
      result.set(field.name, local ?? field.nameSpan);
    }
  return result;
};

const buildModules = (
  graph: ModuleGraph,
  external: Map<symbol, Export>,
): Check<Body<Type>> =>
  code.body(
    check(function* () {
      const param = code.binding("value", fresh());
      const unit = record(row());
      const printed = yield* code.declare(
        "print",
        code.fn(fn(param.type, unit), param, {
          declarations: [],
          result: code.print(unit, code.ref(param)),
        }),
      );
      const primitive: Entry = {
        binding: printed.node.binding,
        scheme: generalize(printed.type, new Map()),
      };
      const completed = new Map<string, ReadonlyMap<string, Export>>();
      for (const module of graph.modules) {
        const imported = new Map<string, Export>();
        for (const dependency of module.imports)
          for (const [name, entry] of completed.get(dependency.uri)!) {
            const previous = imported.get(name);
            if (previous && previous.identity !== entry.identity)
              return yield* fail(`Conflicting imported name: ${name}`)
                .at(dependency.span)
                .inDocument(module.uri);
            imported.set(name, entry);
          }
        const environment = new Map<string, Entry>([["print", primitive], ...imported]);
        const parsed = parse(module.source);
        if (!parsed.success)
          return yield* fail(parsed.error.message).at(parsed.error.span).inDocument(module.uri);
        if (module.uri === graph.root) {
          for (const entry of imported.values()) external.set(entry.binding.id, entry);
          return yield* within(env, environment, elaborate(parsed.value)).inDocument(module.uri);
        }
        const initial = yield* within(
          observe,
          false,
          within(env, environment, elaborate(parsed.value)),
        ).inDocument(module.uri);
        const type = prune(initial.type);
        if (type.kind !== "record")
          return yield* fail(`Imported module must return a record: ${module.uri}`)
            .at(parsed.value.span)
            .inDocument(module.uri);
        const value = yield* code.declare("module", initial);
        const entries = new Map(imported);
        const origins = exportOrigins(parsed.value);
        for (const [name, fieldType] of flatten(type.row).fields) {
          if (entries.has(name))
            return yield* fail(`Conflicting exported name: ${name}`)
              .at(origins.get(name) ?? parsed.value.span)
              .inDocument(module.uri);
          const reference = yield* code.declare(name, code.field(fieldType, value, name));
          entries.set(name, {
            binding: reference.node.binding,
            scheme: generalize(fieldType, environment),
            identity: Symbol(name),
            origin: { uri: module.uri, name, span: origins.get(name) ?? parsed.value.span },
          });
        }
        completed.set(module.uri, entries);
      }
      throw new Error("Module graph has no root");
    }),
  );


export const analyze = (source: string, options: ModuleOptions = {}): Analysis<Type> => {
  const graph = loadModules(source, options, "rows");
  const lexical = highlight(source, tokens);
  if (!graph.success)
    return {
      diagnostics: [graph.error],
      types: [],
      definitions: [],
      references: [],
      tokens: lexical,
    };
  const external = new Map<symbol, Export>();
  const analysis = facts.collect(buildModules(graph.value, external), lexical).analysis;
  return {
    ...analysis,
    diagnostics: analysis.diagnostics.map((error) => graph.value.routeDiagnostic(error)),
    sources: graph.value.sources,
    dependencyUris: graph.value.dependencyUris,
    definitions: [
      ...analysis.definitions,
      ...[...external.values()]
        .filter((entry) =>
          analysis.references.some((reference) => reference.id === entry.binding.id),
        )
        .map((entry) => ({
          ...entry.binding,
          span: entry.origin.span,
          uri: entry.origin.uri,
          kind:
            prune(entry.scheme.type).kind === "function"
              ? ("function" as const)
              : ("variable" as const),
        })),
    ],
  };
};

export const compile = (source: string, options: ModuleOptions = {}): Result<Compiled> => {
  const graph = loadModules(source, options, "rows");
  if (!graph.success) return graph;
  const built = run(buildModules(graph.value, new Map()));
  if (!built.success) return { success: false, error: graph.value.routeDiagnostic(built.error) };
  return {
    success: true,
    value: {
      type: built.value.result.type,
      ir: built.value,
      javascript: javascript.emit(built.value, {
        operations: code.operationTraversals(),
        coreFunctionId: code.coreFunctionId(),
      }),
    },
  };
};

if (import.meta.main) {
  const file = process.argv[2]
    ? pathToFileURL(resolve(process.argv[2]))
    : new URL("./main.rows", import.meta.url);
  const source = readFileSync(file, "utf8");
  const result = compile(source, { uri: file.href });
  if (!result.success) {
    console.error(render(result.error, source));
    process.exitCode = 1;
  } else console.log(runInNewContext(result.value.javascript, { console }, { timeout: 1000 }));
}
