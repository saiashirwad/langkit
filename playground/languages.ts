import type { Result } from "langkit";
import type { Analysis } from "langkit/analysis";
import type { AnalysisContext } from "langkit/lsp";
import { evaluate } from "./custom.ts";

export const names = ["toy", "hm", "rows", "advanced", "strict", "ur", "schema"] as const;

export type Name = (typeof names)[number];

/** What the playground needs from a language module: the same exports the CLI and LSP use. */
export type Language = {
  readonly analyze: (source: string, context: AnalysisContext) => Analysis<unknown>;
  readonly show: (type: unknown) => string;
  readonly compile: (source: string, context: AnalysisContext) => Result<unknown>;
};

/** Sent to each worker. Files and sources are keyed by URI, like file:///examples/toy/main.toy. */
export type Setup = {
  readonly name: Name;
  readonly files: Readonly<Record<string, string>>;
  /** Present while the language itself is being edited. */
  readonly sources?: Readonly<Record<string, string>>;
};

const modules: Record<Name, () => Promise<unknown>> = {
  toy: () => import("../examples/toy/toy.ts"),
  hm: () => import("../examples/hm/hm.ts"),
  rows: () => import("../examples/rows/rows.ts"),
  advanced: () => import("../examples/advanced/advanced.ts"),
  strict: () => import("../examples/strict/strict.ts"),
  ur: () => import("../examples/ur/ur.ts"),
  schema: () => import("../examples/schema/schema.ts"),
};

export const entry = (name: Name): string => `file:///examples/${name}/${name}.ts`;

export const load = async (setup: Setup): Promise<Language> =>
  (setup.sources
    ? evaluate(new Map(Object.entries(setup.sources)), entry(setup.name))
    : await modules[setup.name]()) as Language;

/** Files that are not open in the editor are read from the setup snapshot. */
export const reader =
  (files: Readonly<Record<string, string>>) =>
  (uri: string): string => {
    const text = files[uri];
    if (text === undefined) throw new Error(`No file ${uri}`);
    return text;
  };
