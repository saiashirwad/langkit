import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commit, createLexemes, many, parser, regex } from "langkit/parse";
import type { Diagnostic, Result, Span } from "langkit";

export type ModuleOptions = {
  readonly uri?: string;
  readonly read?: (uri: string) => string;
};
export type ModuleSource = {
  readonly uri: string;
  readonly source: string;
  readonly original: string;
  readonly imports: readonly { readonly uri: string; readonly span: Span }[];
};

const lex = createLexemes({
  trivia: regex(/(?:\s|\/\/[^\r\n]*|--[^\r\n]*)*/),
  identifier: regex(/[a-zA-Z_]\w*/),
  keywords: ["import"],
});
const imports = parser(function* () {
  yield* regex(/(?:\s|\/\/[^\r\n]*|--[^\r\n]*)*/);
  return yield* many(parser(function* () {
    yield* lex.keyword("import");
    yield* commit();
    const path = yield* lex.token(regex(/"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/));
    yield* lex.symbol(";");
    return JSON.parse(path) as string;
  }).withSpan((path, span) => ({ path, span })));
});

/** Local file imports only. No code is evaluated; offsets in each module survive stripping. */
export const loadModules = (source: string, options: ModuleOptions, extension: string): Result<{
  root: string;
  modules: readonly ModuleSource[];
}> => {
  const error = (message: string, span: Span = { start: 0, end: 0 }, context: readonly string[] = []): Result<never> =>
    ({ success: false, error: { message, span, context } });
  const normalize = (input: string): string => {
    const uri = new URL(input);
    if (uri.protocol !== "file:" || uri.search || uri.hash) throw new Error("Modules require local file URLs without query strings or fragments");
    return pathToFileURL(resolve(fileURLToPath(uri))).href;
  };
  let root: string;
  try { root = normalize(options.uri ?? pathToFileURL(resolve(`input.${extension}`)).href); }
  catch (cause) { return error(`Invalid module URI: ${String(cause)}`); }
  const read = options.read ?? ((uri: string) => readFileSync(fileURLToPath(uri), "utf8"));
  const completed = new Map<string, ModuleSource>();
  const active = new Set<string>();
  const modules: ModuleSource[] = [];
  const visit = (uri: string, original: string): Result<void> => {
    if (completed.has(uri)) return { success: true, value: undefined };
    active.add(uri);
    const parsed = imports.parsePrefix(original);
    if (!parsed.success) return error(parsed.error.message, parsed.error.diagnostic.span, ["parsing imports", uri]);
    const dependencies: { uri: string; span: Span }[] = [];
    for (const imported of parsed.value.value) {
      let target: string;
      try {
        if (!imported.path.startsWith("./") && !imported.path.startsWith("../"))
          throw new Error("Import paths must start with ./ or ../");
        target = normalize(new URL(imported.path, uri).href);
        if (!fileURLToPath(target).endsWith(`.${extension}`))
          throw new Error(`Imports must use .${extension} files`);
      } catch (cause) { return error(`Invalid import ${JSON.stringify(imported.path)}: ${String(cause)}`, imported.span, [uri]); }
      dependencies.push({ uri: target, span: imported.span });
      if (active.has(target)) return error(`Import cycle: ${[...active, target].join(" -> ")}`, imported.span, [uri]);
      if (completed.has(target)) continue;
      let text: string;
      try { text = read(target); }
      catch (cause) { return error(`Cannot read import ${JSON.stringify(imported.path)}: ${String(cause)}`, imported.span, [uri]); }
      const result = visit(target, text);
      if (!result.success) {
        // Imported spans belong to other documents. Route the error through each
        // importer while retaining the path chain, never displaying foreign offsets.
        const diagnostic: Diagnostic = { ...result.error, span: imported.span, context: [uri, ...result.error.context] };
        return { success: false, error: diagnostic };
      }
    }
    // Erase only directives, not prefix comments: language highlighters retain them.
    let stripped = original;
    for (const imported of parsed.value.value.toReversed())
      stripped = stripped.slice(0, imported.span.start) + stripped.slice(imported.span.start, imported.span.end).replace(/[^\r\n]/g, " ") + stripped.slice(imported.span.end);
    const module: ModuleSource = { uri, original, source: stripped, imports: dependencies };
    active.delete(uri);
    completed.set(uri, module);
    modules.push(module);
    return { success: true, value: undefined };
  };
  const loaded = visit(root, source);
  return loaded.success ? { success: true, value: { root, modules } } : loaded;
};
