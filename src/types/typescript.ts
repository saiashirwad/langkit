import { flatten, free, type FreeVariable, type Generic, prune, type Row, type Type } from "./higher-rank.ts";

export type Printed = { readonly text: string; readonly problem: string | undefined; };

const letters = "ABCDEFGHIJKLMNOPQSTUVWXYZ";

export const reserved: ReadonlySet<string> = new Set(
  ("arguments await break case catch class const continue debugger default delete do else enum eval export extends "
    + "false finally for function if implements import in instanceof interface let new null package private "
    + "protected public return static super switch this throw true try typeof var void while with yield").split(" "),
);

export const namer = (datatypes: ReadonlyMap<string, string>) => {
  const used = new Set(datatypes.keys());
  return (preferred: string | undefined) => {
    let name = preferred ?? [...letters].find((letter) => !used.has(letter)) ?? "T";
    for (let index = 1; used.has(name); index++) name = `${preferred ?? "T"}${index}`;
    used.add(name);
    return name;
  };
};

export const printer = (
  datatypes: ReadonlyMap<string, string> = new Map(),
  referenced: Map<string, string> = new Map(),
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
