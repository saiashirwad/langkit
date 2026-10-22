import { commit, createLexemes, many, parsePrefixResult, parser, regex } from "langkit/parse";
import type { ImportParser } from "./advanced-modules.ts";

const lex = createLexemes({
  trivia: regex(/(?:\s|\/\/[^\r\n]*|--[^\r\n]*)*/),
  identifier: /[a-zA-Z_]\w*/,
  keywords: ["import"],
});
const imports = parser(function*() {
  yield* lex.trivia;
  return yield* many(
    parser(function*() {
      yield* lex.keyword("import");
      yield* commit();
      const path = yield* lex.token(regex(/"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/));
      yield* lex.symbol(";");
      return JSON.parse(path) as string;
    }).withSpan((path, span) => ({ path, span })),
  );
});

export const parseImports: ImportParser = (source) => parsePrefixResult(imports, source);
