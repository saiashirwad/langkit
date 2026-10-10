import {
  attempt,
  between,
  choice,
  commit,
  createLexemes,
  many,
  many1,
  optional,
  parser,
  postfix,
  precedence,
  recursive,
  regex,
  sepBy1,
  sepEndBy,
  type Parser,
} from "langkit/parse";
import type { Span } from "langkit";
import type { Operator } from "langkit/ir";
import type { TokenRule } from "langkit/analysis";

type Located<T> = T & { readonly span: Span };

export type PredicateExpr = Located<{ readonly className: string; readonly arg: TypeExpr }>;

export type TypeExpr = Located<
  | { readonly kind: "name"; readonly name: string; readonly args: readonly TypeExpr[] }
  | { readonly kind: "function"; readonly param: TypeExpr; readonly result: TypeExpr }
  | { readonly kind: "forall"; readonly parameters: readonly string[]; readonly body: TypeExpr }
  | {
      readonly kind: "record";
      readonly fields: readonly { readonly name: string; readonly type: TypeExpr }[];
    }
  | {
      readonly kind: "qualified";
      readonly predicates: readonly PredicateExpr[];
      readonly type: TypeExpr;
    }
>;

export type KindExpr = Located<
  | { readonly kind: "type" }
  | { readonly kind: "arrow"; readonly param: KindExpr; readonly result: KindExpr }
>;

export type Pattern = Located<
  | {
      readonly kind: "constructor";
      readonly name: string;
      readonly fields: readonly { readonly name: string; readonly span: Span }[];
    }
  | { readonly kind: "binding"; readonly name: string }
>;

export type DoStep = Located<
  | { readonly kind: "bind"; readonly name: string; readonly nameSpan: Span; readonly value: Expr }
  | { readonly kind: "action"; readonly value: Expr }
  | { readonly kind: "let"; readonly name: string; readonly nameSpan: Span; readonly value: Expr }
>;

export type Expr = Located<
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "name"; readonly name: string }
  | {
      readonly kind: "record";
      readonly fields: readonly { readonly name: string; readonly value: Expr }[];
      readonly base: Expr | undefined;
    }
  | { readonly kind: "field"; readonly record: Expr; readonly name: string }
  | { readonly kind: "binary"; readonly op: Operator; readonly left: Expr; readonly right: Expr }
  | {
      readonly kind: "let";
      readonly name: string;
      readonly nameSpan: Span;
      readonly value: Expr;
      readonly body: Expr;
      readonly annotation: TypeExpr | undefined;
      readonly recursive: boolean;
    }
  | {
      readonly kind: "fn";
      readonly param: string;
      readonly paramSpan: Span;
      readonly body: Expr;
      readonly annotation: TypeExpr | undefined;
    }
  | { readonly kind: "call"; readonly fn: Expr; readonly arg: Expr }
  | { readonly kind: "if"; readonly cond: Expr; readonly then: Expr; readonly else: Expr }
  | { readonly kind: "annotated"; readonly value: Expr; readonly annotation: TypeExpr }
  | {
      readonly kind: "match";
      readonly value: Expr;
      readonly cases: readonly {
        readonly pattern: Pattern;
        readonly body: Expr;
        readonly span: Span;
      }[];
    }
  | { readonly kind: "do"; readonly steps: readonly DoStep[] }
>;

export type DataDecl = Located<{
  readonly name: string;
  readonly nameSpan: Span;
  readonly parameters: readonly string[];
  readonly constructors: readonly {
    readonly name: string;
    readonly nameSpan: Span;
    readonly fields: readonly TypeExpr[];
  }[];
}>;

export type ClassDecl = Located<{
  readonly name: string;
  readonly nameSpan: Span;
  readonly parameter: {
    readonly name: string;
    readonly kind: KindExpr | undefined;
    readonly span: Span;
  };
  readonly methods: readonly Signature[];
}>;

export type InstanceMethod = Located<{
  readonly name: string;
  readonly nameSpan: Span;
  readonly value: Expr;
}>;

export type InstanceDecl = Located<{
  readonly className: string;
  readonly arg: TypeExpr;
  readonly methods: readonly InstanceMethod[];
}>;

export type TopBinding = Located<{
  readonly name: string;
  readonly nameSpan: Span;
  readonly value: Expr;
  readonly recursive: boolean;
}>;

export type Signature = Located<{
  readonly name: string;
  readonly nameSpan: Span;
  readonly type: TypeExpr;
}>;

export type Module = {
  readonly types: readonly DataDecl[];
  readonly classes: readonly ClassDecl[];
  readonly instances: readonly InstanceDecl[];
  readonly bindings: readonly TopBinding[];
  readonly signatures: readonly Signature[];
  readonly body: Expr | undefined;
};

const words = /[a-zA-Z_]\w*/;
const digits = /\d+(?:\.\d+)?/;
const strings = /"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/;
const comments = /(?:\/\/|--)[^\r\n]*/;

const keywords = [
  "let",
  "in",
  "if",
  "then",
  "else",
  "true",
  "false",
  "data",
  "forall",
  "rec",
  "case",
  "of",
  "class",
  "instance",
  "where",
  "do",
  "Type",
  "import",
] as const;

const reserved: ReadonlySet<string> = new Set(keywords);

const lex = createLexemes({
  trivia: regex(/(?:\s|(?:\/\/|--)[^\r\n]*)*/),
  identifier: regex(words),
  keywords,
});

const { keyword, symbol, identifier } = lex;

const located = <T>(p: Parser<T>): Parser<Located<T>> =>
  p.withSpan((value, span) => ({ ...value, span }));

const named = (p: Parser<string>) =>
  p.withSpan((name, span) => ({
    name,
    span: { start: span.start, end: span.start + name.length },
  }));

const lower = identifier.validate(
  (text) => /^[a-z_]/.test(text),
  "Expected a lowercase binding name",
);

const upper = identifier.validate(
  (text) => /^[A-Z]/.test(text),
  "Expected an uppercase constructor or type name",
);

const name = named(identifier);
const bindingName = named(lower);
const constructorName = named(upper);

export const tokens: readonly TokenRule[] = [
  { pattern: comments, kind: () => undefined },
  { pattern: strings, kind: "string" },
  { pattern: words, kind: (text) => (reserved.has(text) ? "keyword" : "variable") },
  { pattern: digits, kind: "number" },
  { pattern: /==|=>|->|<-|[+\-*/>=:|\\]/, kind: "operator" },
];

const kindExpression: Parser<KindExpr> = recursive<KindExpr>((kind) => {
  const atom = choice(
    located(keyword("Type").map(() => ({ kind: "type" as const }))),
    between(symbol("("), symbol(")"), kind),
  );
  return parser(function* () {
    const param = yield* atom;
    const result = yield* optional(
      parser(function* () {
        yield* symbol("->");
        yield* commit();
        return yield* kind;
      }),
    );
    return result
      ? {
          kind: "arrow" as const,
          param,
          result,
          span: { start: param.span.start, end: result.span.end },
        }
      : param;
  });
});

// Constructor payloads consume type atoms, whereas annotation applications consume
// a head plus atoms. Thus `Cons a (List a)` has two payloads, not one application.
const typeAtom: Parser<TypeExpr> = recursive<TypeExpr>(() =>
  choice(
    located(
      parser(function* () {
        yield* symbol("{");
        yield* commit();
        const fields = yield* sepEndBy(
          parser(function* () {
            const name = yield* identifier;
            yield* symbol(":");
            return { name, type: yield* typeExpression };
          }),
          symbol(","),
        );
        yield* symbol("}");
        return { kind: "record" as const, fields };
      }),
    ),
    name.map(({ name, span }): TypeExpr => ({ kind: "name", name, args: [], span })),
    between(symbol("("), symbol(")"), typeExpression),
  ),
);

const typeExpression: Parser<TypeExpr> = recursive<TypeExpr>((type) => {
  const quantified = located(
    parser(function* () {
      yield* keyword("forall");
      yield* commit();
      const parameters = yield* many1(lower);
      yield* symbol(".");
      return { kind: "forall" as const, parameters, body: yield* type };
    }),
  );
  const atom = typeAtom;
  const application: Parser<TypeExpr> = parser(function* () {
    const head = yield* atom;
    // Non-name heads cannot be applied in this surface language.
    if (head.kind !== "name") return head;
    const args = yield* many(atom);
    return args.length
      ? {
          ...head,
          args: [...head.args, ...args],
          span: { start: head.span.start, end: args.at(-1)!.span.end },
        }
      : head;
  });
  const predicate = located(
    parser(function* () {
      const className = yield* upper;
      const arg = yield* application;
      return { className, arg };
    }),
  );
  const qualified = parser(function* () {
    // Only the prefix backtracks. Once => is recognized, malformed bodies fail.
    const predicates = yield* attempt(
      parser(function* () {
        const predicates = yield* choice(
          between(symbol("("), symbol(")"), sepBy1(predicate, symbol(","))),
          predicate.map((value) => [value]),
        );
        yield* symbol("=>");
        return predicates;
      }),
    );
    yield* commit();
    const result = yield* type;
    return {
      kind: "qualified" as const,
      predicates,
      type: result,
      span: { start: predicates[0]!.span.start, end: result.span.end },
    };
  });
  const arrow = parser(function* () {
    const param = yield* application;
    const result = yield* optional(
      parser(function* () {
        yield* symbol("->");
        yield* commit();
        return yield* type;
      }),
    );
    return result
      ? {
          kind: "function" as const,
          param,
          result,
          span: { start: param.span.start, end: result.span.end },
        }
      : param;
  });
  return choice(quantified, qualified, arrow);
});

const annotation = optional(
  parser(function* () {
    yield* symbol(":");
    yield* commit();
    return yield* typeExpression;
  }),
);

type Parameter = { name: string; span: Span; annotation: TypeExpr | undefined };

const parameter: Parser<Parameter> = choice(
  bindingName.map((value) => ({ ...value, annotation: undefined })),
  between(
    symbol("("),
    symbol(")"),
    parser(function* () {
      const value = yield* bindingName;
      yield* symbol(":");
      return { ...value, annotation: yield* typeExpression };
    }),
  ),
);

const lambdas = (params: readonly Parameter[], body: Expr): Expr =>
  params.reduceRight<Expr>(
    (body, param) => ({
      kind: "fn",
      param: param.name,
      paramSpan: param.span,
      annotation: param.annotation,
      body,
      span: { start: param.span.start, end: body.span.end },
    }),
    body,
  );

const pattern: Parser<Pattern> = choice(
  located(
    parser(function* () {
      const name = yield* upper;
      return { kind: "constructor" as const, name, fields: yield* many(bindingName) };
    }),
  ),
  bindingName.map(({ name, span }): Pattern => ({ kind: "binding", name, span })),
);

const expression: Parser<Expr> = recursive<Expr>((expr) => {
  const binding = located(
    parser(function* () {
      yield* keyword("let");
      yield* commit();
      const rec = yield* optional(keyword("rec"));
      const id = yield* bindingName;
      const type = yield* annotation;
      const params = yield* many(parameter);
      yield* symbol("=");
      const value = lambdas(params, yield* expr);
      yield* keyword("in");
      return {
        kind: "let" as const,
        name: id.name,
        nameSpan: id.span,
        annotation: type,
        recursive: rec !== undefined,
        value,
        body: yield* expr,
      };
    }),
  );
  const lambda = located(
    parser(function* () {
      yield* symbol("\\");
      yield* commit();
      const params = yield* many1(parameter);
      yield* symbol("->");
      return lambdas(params, yield* expr);
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
      return { kind: "if" as const, cond, then, else: yield* expr };
    }),
  );
  const match = located(
    parser(function* () {
      yield* keyword("case");
      yield* commit();
      const value = yield* expr;
      yield* keyword("of");
      yield* symbol("{");
      const cases = yield* sepEndBy(
        located(
          parser(function* () {
            const arm = yield* pattern;
            yield* symbol("->");
            return { pattern: arm, body: yield* expr };
          }),
        ),
        symbol(";"),
      );
      yield* symbol("}");
      return { kind: "match" as const, value, cases };
    }),
  );
  const block = located(
    parser(function* () {
      yield* keyword("do");
      yield* commit();
      yield* symbol("{");
      const step: Parser<DoStep> = choice(
        located(
          parser(function* () {
            yield* keyword("let");
            yield* commit();
            const id = yield* bindingName;
            yield* symbol("=");
            return { kind: "let" as const, name: id.name, nameSpan: id.span, value: yield* expr };
          }),
        ),
        located(
          parser(function* () {
            const id = yield* attempt(
              parser(function* () {
                const id = yield* bindingName;
                yield* symbol("<-");
                return id;
              }),
            );
            yield* commit();
            return { kind: "bind" as const, name: id.name, nameSpan: id.span, value: yield* expr };
          }),
        ),
        located(expr.map((value) => ({ kind: "action" as const, value }))),
      );
      const steps = yield* sepEndBy(step, symbol(";"));
      yield* symbol("}");
      return { kind: "do" as const, steps };
    }),
  );
  const records = located(
    parser(function* () {
      yield* symbol("{");
      yield* commit();
      const fields = yield* sepEndBy(
        parser(function* () {
          const name = yield* identifier;
          yield* symbol("=");
          return { name, value: yield* expr };
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
      return { kind: "record" as const, fields, base };
    }),
  );
  const grouped = parser(function* () {
    yield* symbol("(");
    yield* commit();
    const value = yield* expr;
    const type = yield* annotation;
    yield* symbol(")");
    return { value, type };
  }).withSpan(
    ({ value, type }, span): Expr =>
      type ? { kind: "annotated", value, annotation: type, span } : value,
  );
  const unsigned: Parser<Expr> = choice(
    records,
    located(
      lex
        .token(regex(strings))
        .map((text) => ({ kind: "string" as const, value: JSON.parse(text) as string })),
    ),
    located(
      lex.token(regex(digits)).map((text) => ({ kind: "number" as const, value: Number(text) })),
    ),
    located(keyword("true").map(() => ({ kind: "boolean" as const, value: true }))),
    located(keyword("false").map(() => ({ kind: "boolean" as const, value: false }))),
    name.map(({ name, span }): Expr => ({ kind: "name", name, span })),
    grouped,
  );
  const negative: Parser<Expr> = located(
    lex
      .token(regex(new RegExp(`-${digits.source}`)))
      .map((text) => ({ kind: "number" as const, value: Number(text) })),
  );
  const access = (base: Parser<Expr>) =>
    postfix(
      base,
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
    );
  const application: Parser<Expr> = parser(function* () {
    const head = yield* access(choice(negative, unsigned));
    const args = yield* many(access(unsigned));
    return args.reduce<Expr>(
      (fn, arg) => ({ kind: "call", fn, arg, span: { start: fn.span.start, end: arg.span.end } }),
      head,
    );
  });
  const binary = (op: Operator) =>
    symbol(op).map(
      () =>
        (left: Expr, right: Expr): Expr => ({
          kind: "binary",
          op,
          left,
          right,
          span: { start: left.span.start, end: right.span.end },
        }),
    );
  const operators = precedence(application, [
    { associativity: "left", operators: [binary("*"), binary("/")] },
    { associativity: "left", operators: [binary("+"), binary("-")] },
    { associativity: "left", operators: [binary(">"), binary("==")] },
  ]);
  return choice(binding, lambda, conditional, match, block, operators);
});

const dataDeclaration: Parser<DataDecl> = located(
  parser(function* () {
    yield* keyword("data");
    yield* commit();
    const id = yield* constructorName;
    const parameters = yield* many(lower);
    yield* symbol("=");
    const constructors = yield* sepBy1(
      parser(function* () {
        const id = yield* constructorName;
        const fields = yield* many(typeAtom);
        return { name: id.name, nameSpan: id.span, fields };
      }),
      symbol("|"),
    );
    yield* symbol(";");
    return { name: id.name, nameSpan: id.span, parameters, constructors };
  }),
);

const signatureBody: Parser<Signature> = located(
  parser(function* () {
    const id = yield* attempt(
      parser(function* () {
        const id = yield* bindingName;
        yield* symbol(":");
        return id;
      }),
    );
    yield* commit();
    const type = yield* typeExpression;
    return { name: id.name, nameSpan: id.span, type };
  }),
);

const signature: Parser<Signature> = located(
  parser(function* () {
    const value = yield* signatureBody;
    yield* symbol(";");
    return value;
  }),
);

const equation: Parser<InstanceMethod> = located(
  parser(function* () {
    const prefix = yield* attempt(
      parser(function* () {
        const id = yield* bindingName;
        const params = yield* many(parameter);
        yield* lex.token(regex(/=(?!=)/));
        return { id, params };
      }),
    );
    yield* commit();
    const value = lambdas(prefix.params, yield* expression);
    return { name: prefix.id.name, nameSpan: prefix.id.span, value };
  }),
);

const classDeclaration: Parser<ClassDecl> = located(
  parser(function* () {
    yield* keyword("class");
    yield* commit();
    const id = yield* constructorName;
    const parameter = yield* choice(
      bindingName.map((value) => ({ ...value, kind: undefined })),
      between(
        symbol("("),
        symbol(")"),
        parser(function* () {
          const value = yield* bindingName;
          yield* symbol(":");
          return { ...value, kind: yield* kindExpression };
        }),
      ),
    );
    yield* keyword("where");
    yield* symbol("{");
    const methods = yield* sepEndBy(signatureBody, symbol(";"));
    yield* symbol("}");
    yield* optional(symbol(";"));
    return { name: id.name, nameSpan: id.span, parameter, methods };
  }),
);

const instanceDeclaration: Parser<InstanceDecl> = located(
  parser(function* () {
    yield* keyword("instance");
    yield* commit();
    const className = yield* upper;
    const arg = yield* typeExpression;
    yield* keyword("where");
    yield* symbol("{");
    const methods = yield* sepEndBy(equation, symbol(";"));
    yield* symbol("}");
    yield* optional(symbol(";"));
    return { className, arg, methods };
  }),
);

const topBinding: Parser<TopBinding> = located(
  parser(function* () {
    const rec = yield* optional(keyword("rec"));
    if (rec) yield* commit();
    const method = yield* equation;
    yield* symbol(";");
    return {
      name: method.name,
      nameSpan: method.nameSpan,
      value: method.value,
      recursive: rec !== undefined,
    };
  }),
);

export const program: Parser<Module> = lex.complete(
  parser(function* () {
    const declarations = yield* many(
      choice(
        dataDeclaration.map((value) => ({ kind: "data" as const, value })),
        classDeclaration.map((value) => ({ kind: "class" as const, value })),
        instanceDeclaration.map((value) => ({ kind: "instance" as const, value })),
        signature.map((value) => ({ kind: "signature" as const, value })),
        topBinding.map((value) => ({ kind: "binding" as const, value })),
      ),
    );
    const types: DataDecl[] = [];
    const classes: ClassDecl[] = [];
    const instances: InstanceDecl[] = [];
    const bindings: TopBinding[] = [];
    const signatures: Signature[] = [];
    for (const declaration of declarations) {
      switch (declaration.kind) {
        case "data":
          types.push(declaration.value);
          break;
        case "class":
          classes.push(declaration.value);
          break;
        case "instance":
          instances.push(declaration.value);
          break;
        case "signature":
          signatures.push(declaration.value);
          break;
        case "binding":
          bindings.push(declaration.value);
          break;
      }
    }
    return { types, classes, instances, bindings, signatures, body: yield* optional(expression) };
  }),
);
