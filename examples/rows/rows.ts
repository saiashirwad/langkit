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
  check,
  fail,
  get,
  render,
  run,
  scoped,
  within,
  type Check,
  type Diagnostic,
  type Result,
  type Span,
} from "langkit";
import { create, type Binding, type Body, type Operator, type Program, type Value } from "langkit/ir";
import { elaboration } from "langkit/ir/check";
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
import { createJudgments, type RuleTable } from "langkit/judgments";
import { createBindings } from "langkit/bindings";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { loadModules, type ModuleOptions, type ModuleGraph } from "langkit/modules";
import { parseImports } from "langkit/modules/imports";

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
  show,
  exclude,
  unify,
  mono,
  generalize,
  instantiate,
  type Type,
  type Scheme,
  type Row,
} from "langkit/types/rows";
export { show, type Type } from "langkit/types/rows";

type Entry = { readonly binding: Binding<Type>; readonly scheme: Scheme };

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
const code = elaboration(create<Type>().use(recordFeature).use(printingFeature));
const javascript = createJavaScriptEmitter<Type>(
  coreJavaScript(code.coreDescriptors),
  recordsJavaScript(recordFeature.descriptors),
  printingJavaScript(printingFeature.descriptors),
);
const facts = createAnalysis<Type>();
const observe = scoped(true);
const bindings = createBindings<Type, Value<Type>, Binding<Type>, Scheme>({
  monomorphic: mono,
  instantiate,
  generalize,
  parameter: code.binding,
  declare: (name, value) => code.check(function* () { return (yield* code.declare(name, value.term)).node.binding; }),
  reference: code.ref,
  define: (binding, type, span, kind) => check(function* () {
    if (yield* get(observe)) yield* facts.define(binding, span, kind === "parameter" ? kind : prune(type).kind === "function" ? "function" : "variable");
  }),
  use: (binding, _type, span) => check(function* () { if (yield* get(observe)) yield* facts.reference(binding, span); }),
});
const env = bindings.environment;
const synthesized = (term: Value<Type>) => ({ type: term.type, term });

const rules: RuleTable<Expr, Type, Value<Type>> = {
  number: { mode: "synth", check: "fromSynth", *synth(expr) {
        if (!Number.isFinite(expr.value)) return yield* fail("Number literal is too large");
        return synthesized(code.literal(number, expr.value));
  } },
  boolean: { mode: "synth", check: "fromSynth", *synth(expr) { return synthesized(code.literal(boolean, expr.value)); } },
  string: { mode: "synth", check: "fromSynth", *synth(expr) { return synthesized(code.literal(string, expr.value)); } },
  record: { mode: "synth", check: "fromSynth", *synth(expr) {
        const fields: { name: string; value: Value<Type> }[] = [];
        const types = new Map<string, Type>();
        for (const field of expr.fields) {
          if (types.has(field.name)) return yield* fail(`Duplicate field: ${field.name}`);
          const value = yield* elaborate(field.value);
          fields.push({ name: field.name, value });
          types.set(field.name, value.type);
        }
         if (!expr.base) return synthesized(code.record(record(row(types)), fields));
        const base = yield* elaborate(expr.base);
        const tail = yield* freshRow();
        yield* unify(base.type, record(row(new Map(), tail))).at(expr.base.span);
        yield* exclude(row(new Map(), tail), types.keys()).at(expr.base.span);
        return synthesized(code.record(record(row(types, tail)), fields, base));
  } },
  field: { mode: "synth", check: "fromSynth", *synth(expr) {
        const base = yield* elaborate(expr.record);
        const type = yield* fresh();
        const tail = yield* freshRow([expr.name]);
        yield* unify(base.type, record(row(new Map([[expr.name, type]]), tail)));
        return synthesized(code.field(type, base, expr.name));
  } },
  name: { mode: "synth", check: "fromSynth", *synth(expr) { return yield* bindings.reference(expr.name, expr.span); } },
  binary: { mode: "synth", check: "fromSynth", *synth(expr) {
        const left = yield* elaborate(expr.left);
        const right = yield* elaborate(expr.right);
        yield* unify(left.type, number).at(expr.left.span).recover();
        yield* unify(right.type, number).at(expr.right.span).recover();
        return synthesized(code.binary(
          expr.op === ">" || expr.op === "==" ? boolean : number,
          expr.op,
          left,
          right,
        ));
  } },
  let: { mode: "synth", check: "fromSynth", *synth(expr) {
    return synthesized(yield* code.check(function* () {
      return yield* code.scope(function* () {
        return yield* bindings.let(expr.name, expr.nameSpan, elaborate(expr.value).map(synthesized), () => elaborate(expr.body));
      });
    }));
  } },
  fn: { mode: "synth", check: "fromSynth", *synth(expr) {
    return yield* bindings.parameter(expr.param, yield* fresh(), expr.paramSpan, (param) => code.check(function* () {
      const body = yield* code.body(function* () { return yield* elaborate(expr.body); });
      return synthesized(code.fn(fn(param.type, body.result.type), param, body));
    }));
  } },
  call: { mode: "synth", check: "fromSynth", *synth(expr) {
        const callee = yield* elaborate(expr.fn);
        const arg = yield* elaborate(expr.arg);
        const result = yield* fresh();
        yield* unify(callee.type, fn(arg.type, result)).at(expr.arg.span);
        return synthesized(code.call(result, callee, arg));
  } },
  if: { mode: "synth", check: "fromSynth", *synth(expr) {
    return yield* code.check(function* () {
        const cond = yield* elaborate(expr.cond);
        yield* unify(cond.type, boolean).at(expr.cond.span).recover();
        const then = yield* code.body(function* () { return yield* elaborate(expr.then); });
        const otherwise = yield* code.body(function* () { return yield* elaborate(expr.else); });
        yield* unify(then.result.type, otherwise.result.type).at(expr.else.span).recover();
        return synthesized(code.conditional(then.result.type, cond, then, otherwise));
    });
  } },
};
const judgments = createJudgments(rules, {
  modes: { enter: (expected, body) => body(expected), accept: (actual, expected) => unify(actual.type, expected).map(() => actual.term) },
  source: (expr) => ({ span: expr.span }),
  typed: (type, span) => check(function* () { if (yield* get(observe)) yield* facts.typed(type, span); }),
});
export const elaborate = (expr: Expr): Check<Value<Type>> => judgments.synth(expr).map(({ term }) => code.at(term, expr.span));

export const elaborateBody = (expr: Expr): Check<Body<Type>> =>
  code.body(function* () { return yield* elaborate(expr); });
export type Compiled = {
  readonly type: Type;
  readonly ir: Program<Type>;
  readonly javascript: string;
};

const parse = (source: string): Result<Expr> => {
  const parsed = program.parse(source);
  return parsed.success
    ? parsed
    : {
        success: false,
        errors: [{
          message: parsed.error.message,
          span: parsed.error.diagnostic.span,
          context: ["parsing", ...(parsed.error.diagnostic.context ?? [])],
        }],
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

const printDeclaration = function* () {
  const param = code.binding("value", yield* fresh());
  const unit = record(row());
  const body = yield* code.body(function* () { return code.print(unit, code.ref(param)); });
  return yield* code.declare("print", code.fn(fn(param.type, unit), param, body));
};

const buildModules = (
  graph: ModuleGraph,
  external: Map<symbol, Export>,
): Check<Body<Type>> =>
  code.body(function* () {
      const printed = yield* printDeclaration();
      const primitive: Entry = {
        binding: printed.node.binding,
        scheme: yield* generalize(printed.type, []),
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
        if (!parsed.success) {
          const diagnostic = parsed.errors[0]!;
          let parsing = fail(diagnostic.message).at(diagnostic.span);
          for (const context of diagnostic.context ?? []) parsing = parsing.context(context);
          return yield* parsing.inDocument(module.uri);
        }
        if (module.uri === graph.root) {
          for (const entry of imported.values()) external.set(entry.binding.id, entry);
          return yield* within(env, () => environment, elaborate(parsed.value)).inDocument(module.uri);
        }
        const initial = yield* within(
          observe,
          () => false,
          within(env, () => environment, elaborate(parsed.value)),
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
            scheme: yield* generalize(fieldType, [...environment.values()].map((entry) => entry.scheme)),
            identity: Symbol(name),
            origin: { uri: module.uri, name, span: origins.get(name) ?? parsed.value.span },
          });
        }
        completed.set(module.uri, entries);
      }
      throw new Error("Module graph has no root");
  });


export const analyze = (source: string, options: ModuleOptions = {}): Analysis<Type> => {
  const graph = loadModules(source, options, { extension: "rows", imports: parseImports });
  const lexical = highlight(source, tokens);
  if (!graph.success)
    return {
      diagnostics: graph.errors,
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
  const graph = loadModules(source, options, { extension: "rows", imports: parseImports });
  if (!graph.success) return graph;
  const built = run(buildModules(graph.value, new Map()));
  if (!built.success) {
    const errors: [Diagnostic, ...Diagnostic[]] = [graph.value.routeDiagnostic(built.errors[0])];
    for (let i = 1; i < built.errors.length; i++)
      errors.push(graph.value.routeDiagnostic(built.errors[i]!));
    return { success: false, errors };
  }
  const ir = code.program(built.value);
  return {
    success: true,
    value: {
      type: built.value.result.type,
      ir,
      javascript: javascript.emit(ir),
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
    for (const error of result.errors) console.error(render(error, source));
    process.exitCode = 1;
  } else console.log(runInNewContext(result.value.javascript, { console }, { timeout: 1000 }));
}
