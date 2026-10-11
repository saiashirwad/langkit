import {
  between,
  choice,
  commit,
  createLexemes,
  notFollowedBy,
  parser,
  postfix,
  precedence,
  recursive,
  regex,
  type Parser,
} from "langkit/parse";
import {
  bind,
  fail,
  lookup,
  pure,
  render,
  run,
  scoped,
  type Check,
  type Result,
  type Span,
} from "langkit";
import { create, isReference, type Binding, type Body, type Operator, type Program, type Value } from "langkit/ir";
import { elaboration } from "langkit/ir/check";
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

export type Type =
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | { readonly kind: "function"; readonly param: Type; readonly result: Type };

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
      readonly annotation: Type;
      readonly body: Expr;
    }
  | { readonly kind: "call"; readonly fn: Expr; readonly arg: Expr }
  | { readonly kind: "if"; readonly cond: Expr; readonly then: Expr; readonly else: Expr };

export type Expr = Syntax & { readonly span: Span };

const located = (p: Parser<Syntax>): Parser<Expr> =>
  p.withSpan((node, span) => ({ ...node, span }));

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
  identifier: regex(words),
  keywords,
});
const { keyword, symbol, identifier } = lex;
const name = identifier.withSpan((name, span) => ({
  name,
  span: { start: span.start, end: span.start + name.length },
}));

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
    [{ associativity: "right", operators: [symbol("->").map(() => fn)] }],
  ),
);

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
    const token = op === "-" ? symbol("-").zipLeft(notFollowedBy(symbol(">"))) : symbol(op);
    return token.map(
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

const code = elaboration(create<Type>());
const javascript = createJavaScriptEmitter<Type>(coreJavaScript(code.coreDescriptors));
const facts = createAnalysis<Type>();
const env = scoped<ReadonlyMap<string, Binding<Type>>>(new Map());

const expect = (value: Value<Type>, type: Type): Check<void> =>
  same(value.type, type)
    ? pure(undefined)
    : fail(`Expected ${show(type)}, found ${show(value.type)}`).at(value.span).atomic().recover();

export const elaborate = (expr: Expr): Check<Value<Type>> =>
  code.check(function* () {
    switch (expr.kind) {
      case "number":
        if (!Number.isFinite(expr.value)) return yield* fail("Number literal is too large");
        return code.literal(number, expr.value);
      case "boolean": return code.literal(boolean, expr.value);
      case "name": return code.ref(yield* lookup(env, expr.name));
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
        return code.binary(expr.op === ">" || expr.op === "==" ? boolean : number, expr.op, left, right);
      }
      case "let": return yield* code.scope(function* () {
        const initial = yield* elaborate(expr.value);
        const value = yield* code.declare(expr.name, initial);
        const binding = value.node.binding;
        yield* facts.define(binding, expr.nameSpan, binding.type.kind === "function" ? "function" : "variable");
        return yield* bind(env, [[expr.name, binding]], elaborate(expr.body));
      });
      case "fn": {
        const param = code.binding(expr.param, expr.annotation);
        yield* facts.define(param, expr.paramSpan, "parameter");
        const body = yield* code.body(function* () { return yield* bind(env, [[expr.param, param]], elaborate(expr.body)); });
        return code.fn(fn(param.type, body.result.type), param, body);
      }
      case "call": {
        const callee = yield* elaborate(expr.fn);
        if (callee.type.kind !== "function") return yield* fail(`Expected a function, found ${show(callee.type)}`).at(expr.fn.span);
        const arg = yield* elaborate(expr.arg);
        yield* expect(arg, callee.type.param);
        return code.call(callee.type.result, callee, arg);
      }
      case "if": {
        const cond = yield* elaborate(expr.cond);
        yield* expect(cond, boolean);
        const then = yield* code.body(function* () { return yield* elaborate(expr.then); });
        const otherwise = yield* code.body(function* () { return yield* elaborate(expr.else); });
        yield* expect(otherwise.result, then.result.type);
        return code.conditional(then.result.type, cond, then, otherwise);
      }
    }
  }).flatMap((value) => code.check(function* () {
    if (isReference(value, code.coreReferenceId())) yield* facts.reference(value.node.binding, expr.span);
    yield* facts.typed(value.type, expr.span);
    return code.at(value, expr.span);
  })).at(expr.span);
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
