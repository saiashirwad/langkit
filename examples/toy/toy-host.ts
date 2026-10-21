import { atom, esm, type HostLanguage } from "langkit/host";
import { compile, type Type } from "./toy.ts";

const typescript = (type: Type): string => {
  switch (type.kind) {
    case "number":
    case "boolean":
      return type.kind;
    case "function":
      return `(x: ${typescript(type.param)}) => ${typescript(type.result)}`;
  }
};

export const host: HostLanguage = {
  extension: ".toy",
  host: (source) => {
    const compiled = compile(source);
    if (!compiled.success) return { declarations: [], javascript: undefined, diagnostics: compiled.errors };
    return {
      declarations: [
        "declare const ",
        atom("main", { start: 0, end: source.length }),
        `: ${typescript(compiled.value.type)};\nexport default main;\n`,
      ],
      javascript: esm(compiled.value.javascript, []),
      diagnostics: [],
    };
  },
};
