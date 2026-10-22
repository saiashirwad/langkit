import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  createConnection,
  type Diagnostic as LspDiagnostic,
  DiagnosticSeverity,
  MarkupKind,
  PositionEncodingKind,
  type Range,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import {
  type Analysis,
  definitionAt,
  referenceAt,
  semanticTokens,
  type Token,
  tokenKinds,
  typeAt,
  unanalyzed,
} from "./analysis.ts";
import { type Diagnostic, diagnostic, site, type Span } from "./diagnostic.ts";

const kindIndex = new Map(tokenKinds.map((kind, index) => [kind, index]));

/** LSP tokens cannot cross line endings; lengths and columns are UTF-16. */
const encodeTokens = (document: TextDocument, tokens: readonly Token[]): number[] => {
  const source = document.getText();
  const parts: { line: number; character: number; length: number; type: number; }[] = [];
  for (const token of tokens) {
    const start = Math.max(0, Math.min(source.length, token.span.start));
    const end = Math.max(start, Math.min(source.length, token.span.end));
    for (const match of source.slice(start, end).matchAll(/[^\r\n]+/g)) {
      const position = document.positionAt(start + match.index);
      parts.push({ ...position, length: match[0].length, type: kindIndex.get(token.kind)! });
    }
  }
  parts.sort((a, b) => a.line - b.line || a.character - b.character);
  const data: number[] = [];
  let line = 0;
  let character = 0;
  let previousEnd = 0;
  for (const part of parts) {
    // Ignore overlapping ranges rather than sending an invalid token stream.
    if (part.line === line && part.character < previousEnd) continue;
    data.push(
      part.line - line,
      part.line === line ? part.character - character : part.character,
      part.length,
      part.type,
      0,
    );
    line = part.line;
    character = part.character;
    previousEnd = character + part.length;
  }
  return data;
};

export type AnalysisContext = {
  readonly uri: string;
  readonly read: (uri: string) => string;
};

/** A synchronous adapter with open-buffer import snapshots. No program is executed. */
export const serve = <T>(
  analyze: (source: string, context: AnalysisContext) => Analysis<T>,
  show: (type: T) => string,
): void => {
  const connection = createConnection(process.stdin, process.stdout);
  const documents = new TextDocuments(TextDocument);
  const analyses = new Map<string, Analysis<T>>();
  const encoded = new Map<string, number[]>();
  const dependencies = new Map<string, Set<string>>();
  const range = (document: TextDocument, span: Span): Range => ({
    start: document.positionAt(span.start),
    end: document.positionAt(span.end),
  });

  connection.onInitialize(() => ({
    capabilities: {
      positionEncoding: PositionEncodingKind.UTF16,
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      semanticTokensProvider: {
        legend: { tokenTypes: [...tokenKinds], tokenModifiers: [] },
        full: true,
      },
    },
  }));

  const read = (uri: string): string => documents.get(uri)?.getText() ?? readFileSync(fileURLToPath(uri), "utf8");
  const sourceDocument = (analysis: Analysis<T>, uri: string): TextDocument | undefined => {
    const open = documents.get(uri);
    if (open) return open;
    try {
      return TextDocument.create(uri, "", 0, analysis.sources?.get(uri) ?? read(uri));
    } catch {
      return undefined;
    }
  };

  /** Groups diagnostics by the document they report in, resolving related ranges against known sources. */
  const route = (analysis: Analysis<T>, document: TextDocument): Map<string, LspDiagnostic[]> => {
    const routed = new Map<string, LspDiagnostic[]>([[document.uri, []]]);
    const sources = new Map<string, TextDocument | undefined>();
    const source = (uri: string): TextDocument | undefined => {
      if (!sources.has(uri)) sources.set(uri, sourceDocument(analysis, uri));
      return sources.get(uri);
    };
    const locate = (error: Diagnostic): { uri: string; range: Range; } => {
      const location = site(error, document.uri);
      const target = location && source(location.uri);
      return target && location
        ? { uri: location.uri, range: range(target, location.span) }
        : { uri: document.uri, range: range(document, error.span ?? { start: 0, end: 0 }) };
    };
    for (const error of analysis.diagnostics) {
      const { uri, range: errorRange } = locate(error);
      const relatedInformation = (error.related ?? []).flatMap(({ location, message }) => {
        const target = source(location.uri);
        return target ? [{ location: { uri: location.uri, range: range(target, location.span) }, message }] : [];
      });
      const item: LspDiagnostic = {
        range: errorRange,
        severity: DiagnosticSeverity.Error,
        source: "langkit",
        message: error.context.length ? `${error.message}\n${error.context.join(" > ")}` : error.message,
        ...(relatedInformation.length ? { relatedInformation } : {}),
      };
      routed.set(uri, [...(routed.get(uri) ?? []), item]);
    }
    return routed;
  };

  const update = (document: TextDocument): void => {
    let analysis: Analysis<T>;
    const reads = new Set<string>();
    const trackedRead = (uri: string): string => {
      // Record before reading: failed analyses still replace their old dependency graph.
      reads.add(uri);
      return read(uri);
    };
    try {
      analysis = analyze(document.getText(), { uri: document.uri, read: trackedRead });
    } catch (error) {
      connection.console.error(`Analysis failed for ${document.uri}: ${String(error)}`);
      analysis = unanalyzed([diagnostic("Internal analysis error")]);
    }
    for (const uri of analysis.dependencyUris ?? []) reads.add(uri);
    for (const uri of analysis.sources?.keys() ?? []) reads.add(uri);
    dependencies.set(document.uri, reads);
    analyses.set(document.uri, analysis);
    encoded.delete(document.uri);
    for (const [uri, items] of route(analysis, document)) {
      const target = documents.get(uri);
      void connection.sendDiagnostics({
        uri,
        ...(target ? { version: target.version } : {}),
        diagnostics: items,
      });
    }
  };

  const refresh = (changedUri: string, includeChanged: boolean): void => {
    const affected = new Set<string>(includeChanged ? [changedUri] : []);
    const inputs = new Set<string>([changedUri]);
    let advanced = true;
    while (advanced) {
      advanced = false;
      for (const document of documents.all()) {
        if (affected.has(document.uri)) continue;
        const reads = dependencies.get(document.uri);
        if (reads && [...inputs].some((uri) => reads.has(uri))) {
          affected.add(document.uri);
          inputs.add(document.uri);
          advanced = true;
        }
      }
    }
    for (const document of documents.all()) {
      if (affected.has(document.uri)) update(document);
    }
  };

  documents.onDidChangeContent(({ document }) => refresh(document.uri, true));

  documents.onDidClose(({ document }) => {
    analyses.delete(document.uri);
    encoded.delete(document.uri);
    dependencies.delete(document.uri);
    void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
    refresh(document.uri, false);
  });

  connection.onHover(({ textDocument, position }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analyses.get(textDocument.uri);
    if (!document || !analysis) return null;
    const offset = document.offsetAt(position);
    const value = typeAt(analysis, offset);
    const definition = value ? undefined : definitionAt(analysis, offset);
    const type = value?.type ?? definition?.type;
    if (type === undefined) return null;
    const hoverSpan = value?.span ?? referenceAt(analysis, offset)?.span ?? definition?.span;
    if (!hoverSpan) return null;
    return {
      contents: { kind: MarkupKind.PlainText, value: show(type) },
      range: range(document, hoverSpan),
    };
  });

  connection.onDefinition(({ textDocument, position }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analyses.get(textDocument.uri);
    if (!document || !analysis) return null;
    const definition = definitionAt(analysis, document.offsetAt(position));
    if (!definition) return null;
    const uri = definition.uri ?? document.uri;
    const target = sourceDocument(analysis, uri);
    return target ? { uri, range: range(target, definition.span) } : null;
  });

  connection.languages.semanticTokens.on(({ textDocument }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analyses.get(textDocument.uri);
    if (!document || !analysis) return { data: [] };
    let data = encoded.get(textDocument.uri);
    if (!data) {
      data = encodeTokens(document, semanticTokens(analysis));
      encoded.set(textDocument.uri, data);
    }
    return { data };
  });

  documents.listen(connection);
  connection.listen();
};
