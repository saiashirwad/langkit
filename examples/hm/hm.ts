import {
  between,
  choice,
  commit,
  createLexemes,
  parser,
  postfix,
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
  type Check,
  type Result,
  type Span,
} from "langkit";
import { create, type Binding, type Body, type Operator, type Program, type Value } from "langkit/ir";
import { elaboration } from "langkit/ir/check";
import { assign, pruneLink } from "langkit/inference";
import {
  create as createAnalysis,
  highlight,
  type Analysis,
  type TokenRule,
} from "langkit/analysis";
import { createJavaScriptEmitter } from "langkit/javascript";
import { coreJavaScript } from "langkit/javascript/core";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";

// Inference belongs to this language, not the IR or the checking runner.
export type Type =
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | { readonly kind: "function"; readonly param: Type; readonly result: Type }
  | Variable;

type Variable = { readonly kind: "variable"; instance?: Type };

type Scheme = { readonly type: Type; readonly variables: ReadonlySet<Variable> };

type Entry = { readonly binding: Binding<Type>; readonly scheme: Scheme };

const number: Type = { kind: "number" };
const boolean: Type = { kind: "boolean" };

const fn = (param: Type, result: Type): Type => ({ kind: "function", param, result });

const fresh = (): Check<Variable> =>
  check(function* () { return { kind: "variable" } as Variable; });
const prune = (type: Type): Type =>
  pruneLink(type, (value) => value.kind === "variable" ? value : null, (variable) => variable.instance);

export const show = (type: Type): string => {
  const names = new Map<Variable, string>();
  const visit = (type: Type): string => {
    type = prune(type);
    if (type.kind === "function") return `(${visit(type.param)} -> ${visit(type.result)})`;
    if (type.kind !== "variable") return type.kind;
    let name = names.get(type);
    if (!name) {
      const index = names.size;
      name = String.fromCharCode(97 + (index % 26)) + (index >= 26 ? Math.floor(index / 26) : "");
      names.set(type, name);
    }
    return name;
  };
  return visit(type);
};

const free = (type: Type, found = new Set<Variable>()): Set<Variable> => {
  type = prune(type);
  if (type.kind === "variable") found.add(type);
  else if (type.kind === "function") {
    free(type.param, found);
    free(type.result, found);
  }
  return found;
};
const unify = (left: Type, right: Type): Check<void> =>
  check(function* () {
    const a = prune(left);
    const b = prune(right);
    if (a === b) return;
    if (a.kind === "variable") {
      if (free(b).has(a)) return yield* fail(`Infinite type: ${show(a)} occurs in ${show(b)}`);
      yield* assign(a, "instance", b);
    } else if (b.kind === "variable") {
      yield* unify(b, a);
    } else if (a.kind === "function" && b.kind === "function") {
      yield* unify(a.param, b.param);
      yield* unify(a.result, b.result);
    } else if (a.kind !== b.kind) {
      return yield* fail(`Cannot unify ${show(a)} with ${show(b)}`);
    }
  }).atomic();

const mono = (type: Type): Scheme => ({ type, variables: new Set() });

const generalize = (type: Type, environment: ReadonlyMap<string, Entry>): Check<Scheme> =>
  check(function* () {
    const variables = free(type);
    for (const { scheme } of environment.values()) {
      // Follow solved variables in the environment too: constraints may have
      // connected an outer parameter to variables introduced in this let value.
      for (const variable of free(scheme.type)) {
        if (!scheme.variables.has(variable)) variables.delete(variable);
      }
    }
    return { type, variables };
  });

const instantiate = (scheme: Scheme): Check<Type> => {
  const replacements = new Map<Variable, Variable>();
  const visit = (type: Type): Check<Type> =>
    check(function* () {
      type = prune(type);
      if (type.kind === "function") {
        const param = yield* visit(type.param);
        const result = yield* visit(type.result);
        return fn(param, result);
      }
      if (type.kind !== "variable" || !scheme.variables.has(type)) return type;
      let replacement = replacements.get(type);
      if (!replacement) {
        replacement = yield* fresh();
        replacements.set(type, replacement);
      }
      return replacement;
    });
  return visit(scheme.type);
};

// Syntax. Source spans survive elaboration into the IR.
type Syntax =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
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
const keywords = ["let", "in", "fn", "if", "then", "else", "true", "false"] as const;
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
const tokens: readonly TokenRule[] = [
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

  const atom = choice(
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
    between(symbol("("), symbol(")"), expr).withSpan(
      (arg, span) =>
        (callee: Expr): Expr => ({
          kind: "call",
          fn: callee,
          arg,
          span: { start: callee.span.start, end: span.end },
        }),
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

// HM selects only the core IR and JavaScript operations.
const code = elaboration(create<Type>());
const javascript = createJavaScriptEmitter<Type>(coreJavaScript(code.coreDescriptors));
const facts = createAnalysis<Type>();
const env = scoped<ReadonlyMap<string, Entry>>(new Map());

const elaborate = (expr: Expr): Check<Value<Type>> =>
  code.check(function* () {
    switch (expr.kind) {
      case "number":
        if (!Number.isFinite(expr.value)) return yield* fail("Number literal is too large");
        return code.literal(number, expr.value);
      case "boolean":
        return code.literal(boolean, expr.value);
      case "name": {
        const { binding, scheme } = yield* lookup(env, expr.name);
        yield* facts.reference(binding, expr.span);
        return code.ref(binding, yield* instantiate(scheme));
      }
      case "binary": {
        const left = yield* elaborate(expr.left);
        const right = yield* elaborate(expr.right);
        // Equality is numeric here, avoiding type-class/qualified-type machinery.
        yield* unify(left.type, number).at(expr.left.span).recover();
        yield* unify(right.type, number).at(expr.right.span).recover();
        return code.binary(
          expr.op === ">" || expr.op === "==" ? boolean : number,
          expr.op,
          left,
          right,
        );
      }
      case "let":
        return yield* code.scope(function* () {
          const initial = yield* elaborate(expr.value);
          const environment = yield* get(env);
          const scheme = yield* generalize(initial.type, environment);
          const value = yield* code.declare(expr.name, initial);
          const binding = value.node.binding;
          yield* facts.define(
            binding,
            expr.nameSpan,
            prune(binding.type).kind === "function" ? "function" : "variable",
          );
          return yield* bind(env, [[expr.name, { binding, scheme }]], elaborate(expr.body));
        });
      case "fn": {
        const param = code.binding(expr.param, yield* fresh());
        yield* facts.define(param, expr.paramSpan, "parameter");
        const entry = { binding: param, scheme: mono(param.type) };
        const body = yield* code.body(function* () {
          return yield* bind(env, [[expr.param, entry]], elaborate(expr.body));
        });
        return code.fn(fn(param.type, body.result.type), param, body);
      }
      case "call": {
        const callee = yield* elaborate(expr.fn);
        const arg = yield* elaborate(expr.arg);
        const result = yield* fresh();
        yield* unify(callee.type, fn(arg.type, result)).at(expr.arg.span).recover();
        return code.call(result, callee, arg);
      }
      case "if": {
        const cond = yield* elaborate(expr.cond);
        yield* unify(cond.type, boolean).at(expr.cond.span).recover();
        const then = yield* code.body(function* () { return yield* elaborate(expr.then); });
        const otherwise = yield* code.body(function* () { return yield* elaborate(expr.else); });
        yield* unify(then.result.type, otherwise.result.type).at(expr.else.span).recover();
        return code.conditional(then.result.type, cond, then, otherwise);
      }
    }
  })
    .flatMap((value) => facts.typed(value.type, expr.span).map(() => code.at(value, expr.span)))
    .at(expr.span);

/** Reusable HM body factory; every run allocates fresh inference variables. */
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
          ...parsed.error.diagnostic,
          message: parsed.error.message,
          context: ["parsing", ...(parsed.error.diagnostic.context ?? [])],
        }],
      };
};

export const analyze = (source: string): Analysis<Type> => {
  const lexical = highlight(source, tokens);
  const parsed = parse(source);
  if (!parsed.success)
    return {
      diagnostics: parsed.errors,
      types: [],
      definitions: [],
      references: [],
      tokens: lexical,
    };
  return facts.collect(elaborateBody(parsed.value), lexical).analysis;
};

export const compile = (source: string): Result<Compiled> => {
  const parsed = parse(source);
  if (!parsed.success) return parsed;
  const built = run(elaborateBody(parsed.value));
  if (!built.success) return built;
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
  const file = process.argv[2] ?? new URL("./main.hm", import.meta.url);
  const source = readFileSync(file, "utf8");
  const result = compile(source);
  if (!result.success) {
    for (const error of result.errors) console.error(render(error, source));
    process.exitCode = 1;
  } else {
    console.log(runInNewContext(result.value.javascript, {}, { timeout: 1000 }));
  }
}
