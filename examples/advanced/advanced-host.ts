import type { Diagnostic, Span } from "langkit";
import { atom, esm, type HostLanguage, type Piece, verbatim } from "langkit/host";
import { flatten, free, type FreeVariable, type Generic, prune, type Row, type Type } from "langkit/types/higher-rank";
import { dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { DataDecl, Expr } from "./advanced-syntax.ts";
import { compile } from "./advanced.ts";

type Printed = { readonly text: string; readonly problem: string | undefined; };

const letters = "ABCDEFGHIJKLMNOPQSTUVWXYZ";

const reserved: ReadonlySet<string> = new Set(
  ("arguments await break case catch class const continue debugger default delete do else enum eval export extends "
    + "false finally for function if implements import in instanceof interface let new null package private "
    + "protected public return static super switch this throw true try typeof var void while with yield").split(" "),
);

const namer = (datatypes: ReadonlyMap<string, string>) => {
  const used = new Set(datatypes.keys());
  return (preferred: string | undefined) => {
    let name = preferred ?? [...letters].find((letter) => !used.has(letter)) ?? "T";
    for (let index = 1; used.has(name); index++) name = `${preferred ?? "T"}${index}`;
    used.add(name);
    return name;
  };
};

const printer = (
  datatypes: ReadonlyMap<string, string>,
  referenced: Map<string, string>,
) =>
(input: Type): Printed => {
  const names = new Map<FreeVariable | Generic, string>();
  const fresh = namer(datatypes);
  let problem: string | undefined;
  const fail = (reason: string) => {
    problem ??= reason;
    return "never";
  };
  const parameter = (variable: FreeVariable | Generic) => {
    const name = fresh(
      variable.kind === "generic" ? variable.name.toUpperCase() : variable.kind === "row-variable" ? "R" : undefined,
    );
    names.set(variable, name);
    return variable.kind === "row-variable" ? `${name} extends object` : name;
  };
  const arrow = (param: Type, result: Type, pending: readonly FreeVariable[], forced: readonly Generic[]) => {
    const mentioned = free(param);
    const here = prune(result).kind === "function" ? pending.filter((variable) => mentioned.has(variable)) : pending;
    const parameters = [...forced, ...here].map(parameter);
    const quantifier = parameters.length ? `<${parameters.join(", ")}>` : "";
    const rest = pending.filter((variable) => !here.includes(variable));
    return `${quantifier}(x: ${print(param, [])}) => ${print(result, rest)}`;
  };
  const record = (input: Row) => {
    const { fields, tail } = flatten(input);
    const members = [...fields].map(([name, type]) => `readonly ${name}: ${print(type, [])}`);
    const shape = members.length ? `{ ${members.join("; ")} }` : undefined;
    if (!tail) return shape ?? "object";
    const absent = [...tail.lacks].filter((label) => !fields.has(label));
    if (absent.length) return fail(`a record row that must lack ${absent.join(", ")}`);
    const rest = names.get(tail) ?? fail("an unbound row variable");
    return shape ? `${shape} & ${rest}` : rest;
  };
  const print = (input: Type, pending: readonly FreeVariable[]): string => {
    const type = prune(input);
    if (type.kind === "function") return arrow(type.param, type.result, pending, []);
    if (type.kind === "forall") {
      const body = prune(type.body);
      return body.kind === "function"
        ? arrow(body.param, body.result, pending, type.variables)
        : fail("a polymorphic value that is not a function");
    }
    if (pending.length) return fail("a polymorphic value that is not a function");
    switch (type.kind) {
      case "number":
      case "boolean":
      case "string":
        return type.kind;
      case "record":
        return record(type.row);
      case "data": {
        const { name } = type.constructor;
        const module = datatypes.get(name);
        if (!module) return fail(`the out-of-scope data type ${name}`);
        referenced.set(name, module);
        return type.args.length ? `${name}<${type.args.map((arg) => print(arg, [])).join(", ")}>` : name;
      }
      case "generic":
      case "variable":
        return names.get(type) ?? fail("an unbound type variable");
      case "skolem":
        return fail(`the rigid type variable ${type.name}`);
    }
  };
  const text = print(input, [...free(input)]);
  return { text, problem };
};

const brand = (declaration: DataDecl, datatypes: ReadonlyMap<string, string>): Piece[] => {
  const parameters = declaration.parameters.map((parameter) => parameter.toUpperCase()).map(namer(datatypes));
  const tuple = `readonly [${parameters.join(", ")}]`;
  return [
    `declare const $${declaration.name}: unique symbol;\nexport type `,
    verbatim(declaration.name, declaration.nameSpan),
    `${
      parameters.length ? `<${parameters.join(", ")}>` : ""
    } = { readonly [$${declaration.name}]: (x: ${tuple}) => ${tuple} };\n`,
  ];
};

const specifier = (from: string, to: string): string => {
  const path = relative(dirname(fileURLToPath(from)), fileURLToPath(to)).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
};

const exported = (body: Expr) => {
  const binders = new Map<string, Span>();
  let result = body;
  while (result.kind === "let") {
    binders.set(result.name, result.nameSpan);
    result = result.body;
  }
  const origin = (name: string): Span => {
    const field = result.kind === "record" ? result.fields.find((candidate) => candidate.name === name) : undefined;
    if (!field) return result.span;
    const binder = field.value.kind === "name" && field.value.name === name ? binders.get(name) : undefined;
    return binder ?? field.nameSpan;
  };
  return { result, origin };
};

const unrepresentable = (name: string, reason: string, span: Span): Diagnostic => ({
  message: `TypeScript cannot represent ${name}: ${reason}`,
  span,
  context: [],
});

export const host: HostLanguage = {
  extension: ".advanced",
  host: (source, uri) => {
    const compiled = compile(source, { uri });
    if (!compiled.success) return { declarations: [], javascript: undefined, diagnostics: compiled.errors };
    const { type, syntax, datatypes, javascript } = compiled.value;
    const referenced = new Map<string, string>();
    const typescript = printer(datatypes, referenced);
    const { result, origin } = exported(syntax.body);
    const diagnostics: Diagnostic[] = [];
    const declarations: Piece[] = syntax.types.flatMap((declaration) => brand(declaration, datatypes));
    const resultType = prune(type);
    const fields = resultType.kind === "record" && !flatten(resultType.row).tail
      ? [...flatten(resultType.row).fields]
      : [];
    const members: string[] = [];
    for (const [name, fieldType] of fields) {
      const span = origin(name);
      const printed = typescript(fieldType);
      const problem = name === "default" ? "a field called default collides with the default export" : printed.problem;
      if (problem) {
        diagnostics.push(unrepresentable(name, problem, span));
        continue;
      }
      members.push(`readonly ${name}: ${printed.text}`);
      declarations.push(
        ...(reserved.has(name)
          ? ["declare const ", atom(`$${name}`, span), `: ${printed.text};\nexport { $${name} as ${name} };\n`]
          : [
            "export declare const ",
            source.slice(span.start, span.end) === name ? verbatim(name, span) : atom(name, span),
            `: ${printed.text};\n`,
          ]),
      );
    }
    const main = fields.some(([name]) => name === "main") ? "$main" : "main";
    const printed = fields.length
      ? { text: members.length ? `{ ${members.join("; ")} }` : "object", problem: undefined }
      : typescript(type);
    if (printed.problem) diagnostics.push(unrepresentable("the module result", printed.problem, result.span));
    else declarations.push("declare const ", atom(main, result.span), `: ${printed.text};\nexport default ${main};\n`);
    const imports = Map.groupBy([...referenced].filter(([, module]) => module !== uri), ([, module]) => module);
    return {
      declarations: [
        ...[...imports].map(([module, names]) =>
          `import type { ${names.map(([name]) => name).sort().join(", ")} } from "${specifier(uri, module)}";\n`
        ),
        ...declarations,
      ],
      javascript: diagnostics.length ? undefined : esm(javascript, fields.map(([name]) => name)),
      diagnostics,
    };
  },
};
