import { atom, esm, type HostLanguage, unhosted } from "langkit/host";
import { checkSource, emit, type Type } from "./toy.ts";

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
    const checked = checkSource(source);
    if (!checked.success) return unhosted(checked.errors);
    return {
      declarations: [
        "declare const ",
        atom("main", { start: 0, end: source.length }),
        `: ${typescript(checked.value.type)};\nexport default main;\n`,
      ],
      javascript: () => esm(emit(checked.value), []),
      diagnostics: [],
    };
  },
};
