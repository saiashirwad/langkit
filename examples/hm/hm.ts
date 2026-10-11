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
  fail,
  render,
  run,
  type Check,
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
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { createJudgments, type RuleTable } from "langkit/judgments";
import { createBindings } from "langkit/bindings";

import {
  number,
  boolean,
  fn,
  fresh,
  prune,
  show,
  unify,
  mono,
  generalize,
  instantiate,
  type Type,
  type Scheme,
} from "langkit/types/hm";
export { show, type Type } from "langkit/types/hm";

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

const code = elaboration(create<Type>());
const javascript = createJavaScriptEmitter<Type>(coreJavaScript(code.coreDescriptors));
const facts = createAnalysis<Type>();
const bindings = createBindings<Type, Value<Type>, Binding<Type>, Scheme>({
  monomorphic: mono,
  instantiate,
  generalize,
  parameter: code.binding,
  declare: (name, value) => code.check(function* () { return (yield* code.declare(name, value.term)).node.binding; }),
  reference: code.ref,
  define: (binding, type, span, kind) => facts.define(binding, span, kind === "parameter" ? kind : prune(type).kind === "function" ? "function" : "variable"),
  use: (binding, _type, span) => facts.reference(binding, span),
});
const synthesized = (term: Value<Type>) => ({ type: term.type, term });
const rules: RuleTable<Expr, Type, Value<Type>> = {
  number: { mode: "synth", check: "fromSynth", *synth(expr) {
        if (!Number.isFinite(expr.value)) return yield* fail("Number literal is too large");
        return synthesized(code.literal(number, expr.value));
  } },
  boolean: { mode: "synth", check: "fromSynth", *synth(expr) { return synthesized(code.literal(boolean, expr.value)); } },
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
        yield* unify(callee.type, fn(arg.type, result)).at(expr.arg.span).recover();
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
  typed: facts.typed,
});
const elaborate = (expr: Expr): Check<Value<Type>> => judgments.synth(expr).map(({ term }) => code.at(term, expr.span));

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
