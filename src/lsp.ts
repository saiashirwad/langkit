import {
  DiagnosticSeverity,
  MarkupKind,
  PositionEncodingKind,
  TextDocuments,
  TextDocumentSyncKind,
  type Connection,
  type Range,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  definitionAt,
  semanticTokens,
  tokenKinds,
  typeAt,
  type Analysis,
  type Token,
} from "./analysis.ts";
import type { Span } from "./diagnostic.ts";

/** LSP tokens cannot cross line endings; lengths and columns are UTF-16. */
export const encodeTokens = (document: TextDocument, tokens: readonly Token[]): number[] => {
  const source = document.getText();
  const parts: { line: number; character: number; length: number; type: number }[] = [];
  for (const token of tokens) {
    const start = Math.max(0, Math.min(source.length, token.span.start));
    const end = Math.max(start, Math.min(source.length, token.span.end));
    for (const match of source.slice(start, end).matchAll(/[^\r\n]+/g)) {
      const position = document.positionAt(start + match.index);
      parts.push({ ...position, length: match[0].length, type: tokenKinds.indexOf(token.kind) });
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

/**
 * A synchronous adapter with open-buffer import snapshots. No program is executed.
 * The caller supplies the connection and reads files that are not open.
 */
export const serve = <T>(
  connection: Connection,
  read: (uri: string) => string,
  analyze: (source: string, context: AnalysisContext) => Analysis<T>,
  show: (type: T) => string,
): void => {
  const documents = new TextDocuments(TextDocument);
  const analyses = new Map<string, Analysis<T>>();
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

  const snapshot = (uri: string): string => documents.get(uri)?.getText() ?? read(uri);

  const update = (document: TextDocument): void => {
    let analysis: Analysis<T>;
    try {
      analysis = analyze(document.getText(), { uri: document.uri, read: snapshot });
    } catch (error) {
      connection.console.error(`Analysis failed for ${document.uri}: ${String(error)}`);
      analysis = {
        diagnostics: [{ message: "Internal analysis error", context: [] }],
        types: [],
        definitions: [],
        references: [],
        tokens: [],
      };
    }
    analyses.set(document.uri, analysis);
    void connection.sendDiagnostics({
      uri: document.uri,
      version: document.version,
      diagnostics: analysis.diagnostics.map((error) => ({
        range: range(document, error.span ?? { start: 0, end: 0 }),
        severity: DiagnosticSeverity.Error,
        source: "langkit",
        message: error.context.length
          ? `${error.message}\n${error.context.join(" > ")}`
          : error.message,
      })),
    });
  };

  // These examples are small: recomputing all open documents keeps transitive
  // imports current without a stale dependency graph after malformed edits.
  documents.onDidChangeContent(() => {
    for (const document of documents.all()) update(document);
  });

  documents.onDidClose(({ document }) => {
    analyses.delete(document.uri);
    void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
    for (const other of documents.all()) if (other.uri !== document.uri) update(other);
  });

  connection.onHover(({ textDocument, position }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analyses.get(textDocument.uri);
    if (!document || !analysis) return null;
    const value = typeAt(analysis, document.offsetAt(position));
    return value
      ? {
          contents: { kind: MarkupKind.PlainText, value: show(value.type) },
          range: range(document, value.span),
        }
      : null;
  });

  connection.onDefinition(({ textDocument, position }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analyses.get(textDocument.uri);
    if (!document || !analysis) return null;
    const definition = definitionAt(analysis, document.offsetAt(position));
    if (!definition) return null;
    const uri = definition.uri ?? document.uri;
    let target = documents.get(uri);
    if (!target) {
      try {
        target = TextDocument.create(uri, "", 0, analysis.sources?.get(uri) ?? snapshot(uri));
      } catch {
        return null;
      }
    }
    return { uri, range: range(target, definition.span) };
  });

  connection.languages.semanticTokens.on(({ textDocument }) => {
    const document = documents.get(textDocument.uri);
    const analysis = analyses.get(textDocument.uri);
    return { data: document && analysis ? encodeTokens(document, semanticTokens(analysis)) : [] };
  });

  documents.listen(connection);
  connection.listen();
};
