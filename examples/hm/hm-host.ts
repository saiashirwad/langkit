import { atom, esm, type HostLanguage } from "langkit/host";
import { free, prune, type Type, type Variable } from "langkit/types/hm";
import { compile } from "./hm.ts";

const parameterNames = (type: Type): readonly Variable[] => {
  const pruned = prune(type);
  return pruned.kind === "function" ? [...free(pruned.param), ...parameterNames(pruned.result)] : [];
};

const typescript = (type: Type): string => {
  const names = new Map<Variable, string>();
  const name = (variable: Variable): string => {
    if (!names.has(variable)) {
      const index = names.size;
      names.set(variable, String.fromCharCode(65 + (index % 26)) + (index >= 26 ? Math.floor(index / 26) : ""));
    }
    return names.get(variable)!;
  };
  const bound = new Set<Variable>();
  const quantifier = (introduced: readonly Variable[]): string => {
    const fresh = [...new Set(introduced)].filter((variable) => !bound.has(variable));
    for (const variable of fresh) bound.add(variable);
    return fresh.length ? `<${fresh.map(name).join(", ")}>` : "";
  };
  const visit = (input: Type, outermost: boolean): string => {
    const type = prune(input);
    switch (type.kind) {
      case "number":
      case "boolean":
        return type.kind;
      case "variable":
        return name(type);
      case "function": {
        const unmentioned = outermost
          ? [...free(type)].filter((variable) => !parameterNames(type).includes(variable))
          : [];
        const generics = quantifier([...free(type.param), ...unmentioned]);
        return `${generics}(x: ${visit(type.param, false)}) => ${visit(type.result, false)}`;
      }
    }
  };
  return visit(type, true);
};

export const host: HostLanguage = {
  extension: ".hm",
  host: (source) => {
    const compiled = compile(source);
    if (!compiled.success) return { declarations: [], javascript: undefined, diagnostics: compiled.errors };
    const { type, result, javascript } = compiled.value;
    if (prune(type).kind === "variable") {
      return {
        declarations: [],
        javascript: undefined,
        diagnostics: [{
          message: "TypeScript cannot represent a result whose type is an unconstrained variable",
          context: ["hosting"],
          span: result,
        }],
      };
    }
    return {
      declarations: ["declare const ", atom("main", result), `: ${typescript(type)};\nexport default main;\n`],
      javascript: esm(javascript, []),
      diagnostics: [],
    };
  },
};
