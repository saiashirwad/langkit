import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Result } from "./check.ts";
import {
  type Diagnostic,
  diagnostic,
  type SourceLocation,
  type Span,
  withDocument,
  withLocation,
} from "./diagnostic.ts";

export type ModuleOptions = { readonly uri?: string; readonly read?: (uri: string) => string; };
export type ImportDirective = { readonly path: string; readonly span: Span; };
export type ImportParser = (source: string) => Result<readonly ImportDirective[]>;
export type ModuleLanguage = { readonly extension: string; readonly imports: ImportParser; };
export type ModuleSource = {
  readonly uri: string;
  readonly source: string;
  readonly original: string;
  readonly imports: readonly { readonly uri: string; readonly span: Span; }[];
};

export const readFileUri = (uri: string): string => {
  const url = new URL(uri);
  if (url.protocol !== "file:") throw new Error("Only local file URLs can be read");
  return readFileSync(fileURLToPath(url), "utf8");
};

export class ModuleGraph {
  readonly root: string;
  readonly modules: readonly ModuleSource[];
  readonly dependencyUris: readonly string[];
  readonly #byUri: ReadonlyMap<string, ModuleSource>;
  constructor(root: string, modules: readonly ModuleSource[]) {
    this.root = root;
    this.modules = modules;
    this.dependencyUris = Object.freeze(modules.filter((module) => module.uri !== root).map((module) => module.uri));
    this.#byUri = new Map(modules.map((module) => [module.uri, module]));
  }
  /** A fresh map each time, so callers cannot corrupt the graph. */
  get sources(): ReadonlyMap<string, string> {
    return new Map(this.modules.map((module) => [module.uri, module.original]));
  }
  routeDiagnostic(diagnostic: Diagnostic): Diagnostic {
    const origin = diagnostic.origin ?? diagnostic.location
      ?? (diagnostic.span === undefined ? undefined : { uri: this.root, span: diagnostic.span });
    if (!origin || origin.uri === this.root) return diagnostic;
    const path: SourceLocation[] = [];
    const seen = new Set<string>();
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
    const related = [
      ...(diagnostic.related ?? []),
      ...path.map((location) => ({ location, message: "Imported here" })),
      { location: origin, message: "Original diagnostic" },
    ];
    const primary = path[0]!;
    return { ...withLocation(diagnostic, primary), span: primary.span, related };
  }
}

const normalize = (input: string): string => {
  const uri = new URL(input);
  if (uri.protocol !== "file:" || uri.search || uri.hash) {
    throw new Error("Modules require local file URLs without query strings or fragments");
  }
  return pathToFileURL(resolve(fileURLToPath(uri))).href;
};

const resolveImport = (path: string, from: string, extension: string): string => {
  if (!path.startsWith("./") && !path.startsWith("../")) throw new Error("Import paths must start with ./ or ../");
  const target = normalize(new URL(path, from).href);
  if (!fileURLToPath(target).endsWith("." + extension)) throw new Error("Imports must use ." + extension + " files");
  return target;
};

/** Blanks import directives so the rest of the source keeps its offsets. */
const strip = (original: string, directives: readonly ImportDirective[]): string =>
  directives.toReversed().reduce(
    (text, { span }) =>
      text.slice(0, span.start) + text.slice(span.start, span.end).replace(/[^\r\n]/g, " ") + text.slice(span.end),
    original,
  );

export const loadModules = (source: string, options: ModuleOptions, language: ModuleLanguage): Result<ModuleGraph> => {
  const { extension } = language;
  const located = (message: string, uri: string, span: Span = { start: 0, end: 0 }): Diagnostic =>
    withDocument(diagnostic(message, span), uri);
  const failure = (errors: readonly [Diagnostic, ...Diagnostic[]]): Result<never> => ({ success: false, errors });
  let root: string;
  try {
    root = normalize(options.uri ?? pathToFileURL(resolve("input." + extension)).href);
  } catch (cause) {
    return failure([located("Invalid module URI: " + String(cause), options.uri ?? "")]);
  }
  const read = options.read ?? readFileUri;
  const completed = new Map<string, ModuleSource>();
  const active = new Set<string>();
  const modules: ModuleSource[] = [];
  const visit = (uri: string, original: string): Result<void> => {
    if (completed.has(uri)) return { success: true, value: undefined };
    active.add(uri);
    const parsed = language.imports(original);
    if (!parsed.success) {
      active.delete(uri);
      return failure(
        parsed.errors.map((error) => withDocument({ ...error, span: error.span ?? { start: 0, end: 0 } }, uri)) as [
          Diagnostic,
          ...Diagnostic[],
        ],
      );
    }
    const directives = [...parsed.value].sort((a, b) => a.span.start - b.span.start);
    let end = 0;
    for (const directive of directives) {
      const span = directive.span;
      if (
        !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < end || span.end <= span.start
        || span.end > original.length
      ) {
        active.delete(uri);
        return failure([
          located("Invalid import directive span: spans must be nonempty, in range, and nonoverlapping", uri),
        ]);
      }
      end = span.end;
    }
    const dependencies: { uri: string; span: Span; }[] = [];
    const errors: Diagnostic[] = [];
    for (const imported of directives) {
      let target: string;
      try {
        target = resolveImport(imported.path, uri, extension);
      } catch (cause) {
        errors.push(
          located("Invalid import " + JSON.stringify(imported.path) + ": " + String(cause), uri, imported.span),
        );
        continue;
      }
      dependencies.push({ uri: target, span: imported.span });
      if (active.has(target)) {
        errors.push(located("Import cycle: " + [...active, target].join(" -> "), uri, imported.span));
        continue;
      }
      if (completed.has(target)) continue;
      let text: string;
      try {
        text = read(target);
      } catch (cause) {
        errors.push(
          located("Cannot read import " + JSON.stringify(imported.path) + ": " + String(cause), uri, imported.span),
        );
        continue;
      }
      const result = visit(target, text);
      if (!result.success) {
        const location = { uri, span: imported.span };
        errors.push(
          ...result.errors.map((error) => ({
            ...withLocation(error, location),
            span: imported.span,
            related: [...(error.related ?? []), {
              location: error.origin ?? location,
              message: "Imported dependency failure",
            }],
          })),
        );
      }
    }
    if (errors.length) {
      active.delete(uri);
      return failure(errors as [Diagnostic, ...Diagnostic[]]);
    }
    const module: ModuleSource = { uri, original, source: strip(original, directives), imports: dependencies };
    active.delete(uri);
    completed.set(uri, module);
    modules.push(module);
    return { success: true, value: undefined };
  };
  const loaded = visit(root, source);
  return loaded.success ? { success: true, value: new ModuleGraph(root, modules) } : loaded;
};
