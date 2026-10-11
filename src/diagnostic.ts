export type Span = { readonly start: number; readonly end: number };

export type SourceLocation = { readonly uri: string; readonly span: Span };

export type RelatedDiagnostic = {
  readonly location: SourceLocation;
  readonly message: string;
};

export type Diagnostic = {
  readonly code?: string;
  readonly invocation?: symbol;
  readonly reasons?: readonly symbol[];
  readonly message: string;
  readonly context: readonly string[];
  /** Local checker span retained for source-compatible rendering and consumers. */
  readonly span?: Span;
  /** Original location where the failure was produced. */
  readonly origin?: SourceLocation;
  /** Primary location to present or navigate to. */
  readonly location?: SourceLocation;
  readonly related?: readonly RelatedDiagnostic[];
};

/** Attach the document identity to a local diagnostic without replacing source locations. */
export const withDocument = (diagnostic: Diagnostic, uri: string): Diagnostic => {
  if (diagnostic.span === undefined) return diagnostic;
  const origin = diagnostic.origin ?? diagnostic.location ?? { uri, span: diagnostic.span };
  return { ...diagnostic, origin, location: diagnostic.location ?? origin };
};

/** Choose a presentation location while preserving the original failure origin. */
export const withLocation = (diagnostic: Diagnostic, location: SourceLocation): Diagnostic => {
  const origin = diagnostic.origin ?? diagnostic.location ?? (diagnostic.span ? { uri: location.uri, span: diagnostic.span } : undefined);
  return origin ? { ...diagnostic, origin, location } : { ...diagnostic, location };
};

export const render = (error: Diagnostic, source?: string): string => {
  const context = error.context.length ? `\nWhile checking: ${error.context.join(" > ")}` : "";
  if (source === undefined || error.span === undefined) return error.message + context;
  const { start, end } = error.span;
  const before = source.slice(0, start).split("\n");
  const line = before.length;
  const column = before.at(-1)!.length;
  const text = source.split("\n")[line - 1] ?? "";
  const underline = "^".repeat(Math.max(1, Math.min(end - start, text.length - column)));
  return [
    `line ${line}, column ${column + 1}: ${error.message}`,
    text,
    " ".repeat(column) + underline + context,
  ].join("\n");
};
