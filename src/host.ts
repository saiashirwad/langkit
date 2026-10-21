import type { Diagnostic, Span } from "./diagnostic.ts";

export type Mapping = readonly [
  virtualStart: number,
  virtualLength: number,
  originalStart: number,
  originalLength: number,
  kind: 0 | 1,
  features?: number,
];

export type Projection = { readonly text: string; readonly mappings: readonly Mapping[]; };

export type Piece = string | {
  readonly text: string;
  readonly span: Span;
  readonly kind: "verbatim" | "atom";
};

export type Hosted = {
  readonly declarations: readonly Piece[];
  readonly javascript: string | undefined;
  readonly diagnostics: readonly Diagnostic[];
};

export type HostLanguage = {
  readonly extension: `.${string}`;
  readonly host: (source: string, uri: string) => Hosted;
};

const hover = 1 << 0;
const definition = 1 << 3;
const references = 1 << 6;
const atomFeatures = hover | definition | references;

export const verbatim = (text: string, span: Span): Piece => {
  if (span.end - span.start !== text.length) {
    throw new Error(`Verbatim text "${text}" does not match its ${span.end - span.start}-character span`);
  }
  return { text, span, kind: "verbatim" };
};

export const atom = (text: string, span: Span): Piece => ({ text, span, kind: "atom" });

export const project = (pieces: readonly Piece[]): Projection => {
  let text = "";
  const mappings: Mapping[] = [];
  for (const piece of pieces) {
    if (typeof piece !== "string") {
      const original = [piece.span.start, piece.span.end - piece.span.start] as const;
      mappings.push(
        piece.kind === "verbatim"
          ? [text.length, piece.text.length, ...original, 0]
          : [text.length, piece.text.length, ...original, 1, atomFeatures],
      );
    }
    text += typeof piece === "string" ? piece : piece.text;
  }
  return { text, mappings };
};

export const esm = (expression: string, exports: readonly string[]): string =>
  [
    `const module = ${expression.trim()};`,
    "export default module;",
    ...(exports.length
      ? [
        `const { ${exports.map((name, index) => `${JSON.stringify(name)}: $${index}`).join(", ")} } = module;`,
        `export { ${exports.map((name, index) => `$${index} as ${JSON.stringify(name)}`).join(", ")} };`,
      ]
      : []),
    "",
  ].join("\n");
