import { bind, type Check, check, fail, lookup, pure, render, type Result, run, scoped, type Span } from "langkit";
import { type Analysis, create as createAnalysis, highlight, type TokenRule, unanalyzed } from "langkit/analysis";
import type { Binding, Body, Operator, Value } from "langkit/ir";
import * as ir from "langkit/ir";
import * as javascript from "langkit/javascript";
import {
  between,
  choice,
  commit,
  createLexemes,
  located as locate,
  named,
  notFollowedBy,
  type Parser,
  parser,
  parseResult,
  postfix,
  precedence,
  recursive,
  regex,
} from "langkit/parse";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export type Type =
  | { readonly kind: "number"; }
  | { readonly kind: "boolean"; }
  | { readonly kind: "function"; readonly param: Type; readonly result: Type; };

const number: Type = { kind: "number" };
const boolean: Type = { kind: "boolean" };

const fn = (param: Type, result: Type): Type => ({ kind: "function", param, result });

export const show = (type: Type): string =>
  type.kind === "function" ? `(${show(type.param)} -> ${show(type.result)})` : type.kind;

const same = (a: Type, b: Type): boolean =>
  a.kind === "function" && b.kind === "function"
    ? same(a.param, b.param) && same(a.result, b.result)
    : a.kind === b.kind;

type Syntax =
  | { readonly kind: "number"; readonly value: number; }
  | { readonly kind: "boolean"; readonly value: boolean; }
  | { readonly kind: "name"; readonly name: string; }
  | { readonly kind: "binary"; readonly op: Operator; readonly left: Expr; readonly right: Expr; }
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
    readonly annotation: Type;
    readonly body: Expr;
  }
  | { readonly kind: "call"; readonly fn: Expr; readonly arg: Expr; }
  | { readonly kind: "if"; readonly cond: Expr; readonly then: Expr; readonly else: Expr; };

export type Expr = Syntax & { readonly span: Span; };

const located = locate<Syntax>;

const words = /[a-zA-Z_]\w*/;
const digits = /\d+(?:\.\d+)?/;
const keywords = [
  "let",
  "in",
  "fn",
  "if",
  "then",
  "else",
  "true",
  "false",
  "number",
  "boolean",
] as const;
const reserved: ReadonlySet<string> = new Set(keywords);
const lex = createLexemes({
  trivia: regex(/\s*/),
  identifier: words,
  keywords,
});
const { keyword, symbol, identifier } = lex;
const name = named(identifier);

const tokens: readonly TokenRule[] = [
  {
    pattern: words,
    kind: (text) =>
      text === "number" || text === "boolean"
        ? "type"
        : reserved.has(text)
        ? "keyword"
        : "variable",
  },
  { pattern: digits, kind: "number" },
  { pattern: /==|=>|->|[+\-*/>=]/, kind: "operator" },
];

const annotation: Parser<Type> = recursive<Type>((type) =>
  precedence(
    choice(
      keyword("number").map(() => number),
      keyword("boolean").map(() => boolean),
      between(symbol("("), symbol(")"), type),
    ),
    [{ associativity: "right", operator: symbol("->").map(() => fn) }],
  )
);

const expression: Parser<Expr> = recursive<Expr>((expr) => {
  const binding = located(
    parser(function*() {
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
    parser(function*() {
      yield* keyword("fn");
      yield* commit();
      yield* symbol("(");
      const param = yield* name;
      yield* symbol(":");
      const type = yield* annotation;
      yield* symbol(")");
      yield* symbol("=>");
      return {
        kind: "fn",
        param: param.name,
        paramSpan: param.span,
        annotation: type,
        body: yield* expr,
      };
    }),
  );

  const conditional = located(
    parser(function*() {
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
      (arg, span) => (callee: Expr): Expr => ({
        kind: "call",
        fn: callee,
        arg,
        span: { start: callee.span.start, end: span.end },
      }),
    ),
  );

  const binary = (op: Operator) => {
    const token = op === "-" ? symbol("-").zipLeft(notFollowedBy(symbol(">"))) : symbol(op);
    return token.map(
      () => (left: Expr, right: Expr): Expr => ({
        kind: "binary",
        op,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      }),
    );
  };

  const operators = precedence(calls, [
    { associativity: "left", operator: choice(binary("*"), binary("/")) },
    { associativity: "left", operator: choice(binary("+"), binary("-")) },
    { associativity: "left", operator: choice(binary(">"), binary("==")) },
  ]);

  return choice(binding, lambda, conditional, operators);
});

export const program = lex.complete(expression);

const facts = createAnalysis<Type>();
const env = scoped<ReadonlyMap<string, Binding<Type>>>(new Map());

const expect = (value: Value<Type>, type: Type): Check<void> =>
  same(value.type, type)
    ? pure(undefined)
    : fail(`Expected ${show(type)}, found ${show(value.type)}`).at(value.span).recover();

export const elaborate = (expr: Expr): Check<Value<Type>> =>
  check(function*() {
    switch (expr.kind) {
      case "number":
        if (!Number.isFinite(expr.value)) return yield* fail("Number literal is too large");
        return ir.literal(number, expr.value);
      case "boolean":
        return ir.literal(boolean, expr.value);
      case "name":
        return ir.ref(yield* lookup(env, expr.name));
      case "binary": {
        const left = yield* elaborate(expr.left);
        const right = yield* elaborate(expr.right);
        if (expr.op === "==") {
          if (left.type.kind === "function") return yield* fail("Functions cannot be compared");
          yield* expect(right, left.type);
        } else {
          yield* expect(left, number);
          yield* expect(right, number);
        }
        return ir.binary(expr.op === ">" || expr.op === "==" ? boolean : number, expr.op, left, right);
      }
      case "let":
        return yield* ir.scope(check(function*() {
          const initial = yield* elaborate(expr.value);
          const { binding } = yield* ir.declare(expr.name, initial);
          yield* facts.define(binding, expr.nameSpan, binding.type.kind === "function" ? "function" : "variable");
          return yield* bind(env, [[expr.name, binding]], elaborate(expr.body));
        }));
      case "fn": {
        const param = ir.binding(expr.param, expr.annotation);
        yield* facts.define(param, expr.paramSpan, "parameter");
        const body = yield* ir.body(bind(env, [[expr.param, param]], elaborate(expr.body)));
        return ir.fn(fn(param.type, body.result.type), param, body);
      }
      case "call": {
        const callee = yield* elaborate(expr.fn);
        if (callee.type.kind !== "function") {
          return yield* fail(`Expected a function, found ${show(callee.type)}`).at(expr.fn.span);
        }
        const arg = yield* elaborate(expr.arg);
        yield* expect(arg, callee.type.param);
        return ir.call(callee.type.result, callee, arg);
      }
      case "if": {
        const cond = yield* elaborate(expr.cond);
        yield* expect(cond, boolean);
        const then = yield* ir.body(elaborate(expr.then));
        const otherwise = yield* ir.body(elaborate(expr.else));
        yield* expect(otherwise.result, then.result.type);
        return ir.conditional(then.result.type, cond, then, otherwise);
      }
    }
  }).flatMap((value) =>
    check(function*() {
      if (value.kind === "ref") yield* facts.reference(value.binding, expr.span);
      yield* facts.typed(value.type, expr.span);
      return ir.at(value, expr.span);
    })
  ).at(expr.span);
export const elaborateBody = (expr: Expr): Check<Body<Type>> => ir.body(elaborate(expr));

export type Checked = { readonly type: Type; readonly body: Body<Type>; };
export type Compiled = Checked & { readonly javascript: string; };

const parse = (source: string): Result<Expr> => parseResult(program, source);

export const analyze = (source: string): Analysis<Type> => {
  const lexical = highlight(source, tokens);
  const parsed = parse(source);
  if (!parsed.success) return unanalyzed(parsed.errors, lexical);
  return facts.collect(elaborateBody(parsed.value), lexical).analysis;
};

export const checkSource = (source: string): Result<Checked> => {
  const parsed = parse(source);
  if (!parsed.success) return parsed;
  const built = run(elaborateBody(parsed.value));
  return built.success ? { success: true, value: { type: built.value.result.type, body: built.value } } : built;
};

export const compile = (source: string): Result<Compiled> => {
  const checked = checkSource(source);
  if (!checked.success) return checked;
  return { success: true, value: { ...checked.value, javascript: javascript.emit(checked.value.body) } };
};

if (import.meta.main) {
  const file = process.argv[2] ?? new URL("./main.toy", import.meta.url);
  const source = readFileSync(file, "utf8");
  const result = compile(source);
  if (!result.success) {
    console.error(result.errors.map((error) => render(error, source)).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(runInNewContext(result.value.javascript, {}, { timeout: 1000 }));
  }
}
