import { atom, esm, type HostLanguage, unhosted } from "langkit/host";
import { free, type FreeVariable, prune, type Type, variableNames } from "langkit/types/higher-rank";
import { checkSource, emit } from "./hm.ts";

const parameterNames = (type: Type): readonly FreeVariable[] => {
  const pruned = prune(type);
  return pruned.kind === "function" ? [...free(pruned.param), ...parameterNames(pruned.result)] : [];
};

const typescript = (type: Type): string => {
  const name = variableNames<FreeVariable>("A");
  const bound = new Set<FreeVariable>();
  const quantifier = (introduced: readonly FreeVariable[]): string => {
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
      default:
        throw new Error(`HM cannot produce a ${type.kind} type`);
    }
  };
  return visit(type, true);
};

export const host: HostLanguage = {
  extension: ".hm",
  host: (source) => {
    const checked = checkSource(source);
    if (!checked.success) return unhosted(checked.errors);
    const { type, result } = checked.value;
    if (prune(type).kind === "variable") {
      return unhosted([{
        message: "TypeScript cannot represent a result whose type is an unconstrained variable",
        context: ["hosting"],
        span: result,
      }]);
    }
    return {
      declarations: ["declare const ", atom("main", result), `: ${typescript(type)};\nexport default main;\n`],
      javascript: () => esm(emit(checked.value), []),
      diagnostics: [],
    };
  },
};
