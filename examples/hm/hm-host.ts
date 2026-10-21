import { atom, type HostLanguage, unhosted } from "langkit/host";
import { emitModule } from "langkit/javascript";
import { prune } from "langkit/types/higher-rank";
import { printer } from "langkit/types/typescript";
import { checkSource } from "./hm.ts";

const typescript = printer();

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
    const printed = typescript(type);
    if (printed.problem) {
      return unhosted([{
        message: `TypeScript cannot represent the result: ${printed.problem}`,
        context: ["hosting"],
        span: result,
      }]);
    }
    return {
      declarations: ["declare const ", atom("main", result), `: ${printed.text};\nexport default main;\n`],
      javascript: () => emitModule({ imports: [], body: checked.value.body, exports: [] }),
      diagnostics: [],
    };
  },
};
