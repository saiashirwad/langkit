import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commit, createLexemes, many, parser, regex } from "langkit/parse";
import { withDocument, withLocation, type Diagnostic, type Result, type SourceLocation, type Span } from "langkit";

export type ModuleOptions = { readonly uri?: string; readonly read?: (uri: string) => string };
export type ModuleSource = {
  readonly uri: string; readonly source: string; readonly original: string;
  readonly imports: readonly { readonly uri: string; readonly span: Span }[];
};
const lex = createLexemes({
  trivia: regex(/(?:\s|\/\/[^\r\n]*|--[^\r\n]*)*/), identifier: regex(/[a-zA-Z_]\w*/), keywords: ["import"],
});
const imports = parser(function* () {
  yield* regex(/(?:\s|\/\/[^\r\n]*|--[^\r\n]*)*/);
  return yield* many(parser(function* () {
    yield* lex.keyword("import"); yield* commit();
    const path = yield* lex.token(regex(/"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/));
    yield* lex.symbol(";"); return JSON.parse(path) as string;
  }).withSpan((path, span) => ({ path, span })));
});

/** Loaded local-file dependency graph; modules are ordered dependencies-first. */
export class ModuleGraph {
  readonly root: string;
  readonly modules: readonly ModuleSource[];
  readonly dependencyUris: readonly string[];
  readonly sources: ReadonlyMap<string, string>;
  readonly #byUri: ReadonlyMap<string, ModuleSource>;
  constructor(root: string, modules: readonly ModuleSource[]) {
    this.root = root; this.modules = modules;
    this.#byUri = new Map(modules.map((module) => [module.uri, module]));
    this.dependencyUris = modules.filter((module) => module.uri !== root).map((module) => module.uri);
    this.sources = new Map(modules.map((module) => [module.uri, module.original]));
  }
  module(uri: string): ModuleSource | undefined { return this.#byUri.get(uri); }
  reaches(from: string, target: string): boolean {
    const seen = new Set<string>();
    const visit = (uri: string): boolean => {
      if (uri === target) return true;
      if (seen.has(uri)) return false;
      seen.add(uri);
      return this.#byUri.get(uri)?.imports.some((dependency) => visit(dependency.uri)) ?? false;
    };
    return visit(from);
  }
  /** Route a diagnostic through root imports, preserving the failure origin and full chain. */
  routeDiagnostic(diagnostic: Diagnostic): Diagnostic {
    const origin = diagnostic.origin ?? diagnostic.location ?? (diagnostic.span === undefined ? undefined : { uri: this.root, span: diagnostic.span });
    if (!origin || origin.uri === this.root) return diagnostic;
    const path: SourceLocation[] = []; const seen = new Set<string>();
    const find = (uri: string): boolean => {
      if (uri === origin.uri) return true;
      if (seen.has(uri)) return false;
      seen.add(uri);
      for (const edge of this.#byUri.get(uri)?.imports ?? []) {
        path.push({ uri, span: edge.span });
        if (find(edge.uri)) return true;
        path.pop();
      }
      return false;
    };
    if (!find(this.root) || path.length === 0) return diagnostic;
    const related = [...(diagnostic.related ?? []), ...path.map((location) => ({ location, message: "Imported here" })), { location: origin, message: "Original diagnostic" }];
    const primary = path[0]!;
    return { ...withLocation(diagnostic, primary), span: primary.span, related };
  }
}

/** Local file imports only. No code is evaluated; offsets survive directive stripping. */
export const loadModules = (source: string, options: ModuleOptions, extension: string): Result<ModuleGraph> => {
  const diagnostic = (message: string, uri: string, span: Span = { start: 0, end: 0 }): Diagnostic =>
    withDocument({ message, span, context: [] }, uri);
  const failure = (errors: readonly [Diagnostic, ...Diagnostic[]]): Result<never> => ({ success: false, errors });
  const normalize = (input: string): string => {
    const uri = new URL(input);
    if (uri.protocol !== "file:" || uri.search || uri.hash) throw new Error("Modules require local file URLs without query strings or fragments");
    return pathToFileURL(resolve(fileURLToPath(uri))).href;
  };
  let root: string;
  try { root = normalize(options.uri ?? pathToFileURL(resolve("input." + extension)).href); }
  catch (cause) { return failure([diagnostic("Invalid module URI: " + String(cause), options.uri ?? "")]); }
  const read = options.read ?? ((uri: string) => readFileSync(fileURLToPath(uri), "utf8"));
  const completed = new Map<string, ModuleSource>(); const active = new Set<string>(); const modules: ModuleSource[] = [];
  const visit = (uri: string, original: string): Result<void> => {
    if (completed.has(uri)) return { success: true, value: undefined };
    active.add(uri);
    const parsed = imports.parsePrefix(original);
    if (!parsed.success) {
      active.delete(uri);
      return failure([diagnostic(parsed.error.message, uri, parsed.error.diagnostic.span)]);
    }
    const dependencies: { uri: string; span: Span }[] = [];
    const errors: Diagnostic[] = [];
    for (const imported of parsed.value.value) {
      let target: string;
      try {
        if (!imported.path.startsWith("./") && !imported.path.startsWith("../")) throw new Error("Import paths must start with ./ or ../");
        target = normalize(new URL(imported.path, uri).href);
        if (!fileURLToPath(target).endsWith("." + extension)) throw new Error("Imports must use ." + extension + " files");
      } catch (cause) {
        errors.push(diagnostic("Invalid import " + JSON.stringify(imported.path) + ": " + String(cause), uri, imported.span));
        continue;
      }
      dependencies.push({ uri: target, span: imported.span });
      if (active.has(target)) {
        errors.push(diagnostic("Import cycle: " + [...active, target].join(" -> "), uri, imported.span));
        continue;
      }
      if (completed.has(target)) continue;
      let text: string;
      try { text = read(target); }
      catch (cause) {
        errors.push(diagnostic("Cannot read import " + JSON.stringify(imported.path) + ": " + String(cause), uri, imported.span));
        continue;
      }
      const result = visit(target, text);
      if (!result.success) {
        const location = { uri, span: imported.span };
        errors.push(...result.errors.map((error) => ({ ...withLocation(error, location), span: imported.span,
          related: [...(error.related ?? []), { location: error.origin ?? location, message: "Imported dependency failure" }] })));
      }
    }
    if (errors.length) {
      active.delete(uri);
      return failure(errors as [Diagnostic, ...Diagnostic[]]);
    }
    let stripped = original;
    for (const imported of parsed.value.value.toReversed())
      stripped = stripped.slice(0, imported.span.start) + stripped.slice(imported.span.start, imported.span.end).replace(/[^\r\n]/g, " ") + stripped.slice(imported.span.end);
    const module: ModuleSource = { uri, original, source: stripped, imports: dependencies };
    active.delete(uri); completed.set(uri, module); modules.push(module);
    return { success: true, value: undefined };
  };
  const loaded = visit(root, source);
  return loaded.success ? { success: true, value: new ModuleGraph(root, modules) } : loaded;
};
