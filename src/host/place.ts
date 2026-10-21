import type { Diagnostic, SourceLocation, Span } from "../diagnostic.ts";

export type Place =
  | { readonly kind: "here"; readonly span: Span | undefined; }
  | { readonly kind: "elsewhere"; readonly location: SourceLocation; };

export const place = (diagnostic: Diagnostic, uri: string): Place => {
  const local = [diagnostic.origin, diagnostic.location].find((location) => location?.uri === uri);
  if (local) return { kind: "here", span: local.span };
  const foreign = diagnostic.origin ?? diagnostic.location;
  return foreign ? { kind: "elsewhere", location: foreign } : { kind: "here", span: diagnostic.span };
};
