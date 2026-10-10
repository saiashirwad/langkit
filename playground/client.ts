import * as monaco from "monaco-editor";
import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createProtocolConnection,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  HoverRequest,
  InitializedNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
  SemanticTokensRequest,
  type Location,
  type Range,
} from "vscode-languageserver-protocol/browser";

const toRange = (range: Range): monaco.IRange => ({
  startLineNumber: range.start.line + 1,
  startColumn: range.start.character + 1,
  endLineNumber: range.end.line + 1,
  endColumn: range.end.character + 1,
});

const at = (model: monaco.editor.ITextModel, position: monaco.Position) => ({
  textDocument: { uri: model.uri.toString() },
  position: { line: position.lineNumber - 1, character: position.column - 1 },
});

/**
 * A small LSP client: it syncs every model of one Monaco language with the server
 * in a worker, and asks it for diagnostics, hovers, definitions and semantic tokens.
 */
export const connect = (worker: Worker, language: string): monaco.IDisposable => {
  const connection = createProtocolConnection(
    new BrowserMessageReader(worker),
    new BrowserMessageWriter(worker),
  );
  const disposables: monaco.IDisposable[] = [];
  let disposed = false;

  connection.onNotification(PublishDiagnosticsNotification.type, ({ uri, diagnostics }) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (disposed || !model) return;
    monaco.editor.setModelMarkers(
      model,
      "langkit",
      diagnostics.map((diagnostic) => ({
        ...toRange(diagnostic.range),
        severity: monaco.MarkerSeverity.Error,
        message:
          typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value,
      })),
    );
  });
  connection.listen();

  const sync = (model: monaco.editor.ITextModel): void => {
    if (model.getLanguageId() !== language) return;
    const uri = model.uri.toString();
    void connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri,
        languageId: language,
        version: model.getVersionId(),
        text: model.getValue(),
      },
    });
    disposables.push(
      model.onDidChangeContent(() => {
        void connection.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri, version: model.getVersionId() },
          contentChanges: [{ text: model.getValue() }],
        });
      }),
      model.onWillDispose(() => {
        void connection.sendNotification(DidCloseTextDocumentNotification.type, {
          textDocument: { uri },
        });
      }),
    );
  };

  // A request to a stopped worker rejects; the editor then shows nothing.
  const request = async <R>(send: () => Promise<R>): Promise<R | null> => {
    try {
      return await send();
    } catch {
      return null;
    }
  };

  void request(() =>
    connection.sendRequest(InitializeRequest.type, {
      processId: null,
      rootUri: null,
      capabilities: {},
    }),
  ).then((initialized) => {
    if (disposed || !initialized) return;
    void connection.sendNotification(InitializedNotification.type, {});
    for (const model of monaco.editor.getModels()) sync(model);
    disposables.push(monaco.editor.onDidCreateModel(sync));

    disposables.push(
      monaco.languages.registerHoverProvider(language, {
        provideHover: async (model, position) => {
          const hover = await request(() =>
            connection.sendRequest(HoverRequest.type, at(model, position)),
          );
          const contents = hover?.contents;
          if (!hover || typeof contents !== "object" || !("kind" in contents)) return null;
          return {
            contents: [
              {
                value:
                  contents.kind === "markdown"
                    ? contents.value
                    : `\`\`\`\n${contents.value}\n\`\`\``,
              },
            ],
            ...(hover.range ? { range: toRange(hover.range) } : {}),
          };
        },
      }),
      monaco.languages.registerDefinitionProvider(language, {
        provideDefinition: async (model, position) => {
          const found = await request(() =>
            connection.sendRequest(DefinitionRequest.type, at(model, position)),
          );
          const locations = !found ? [] : Array.isArray(found) ? found : [found];
          return locations
            .filter((location): location is Location => "uri" in location)
            .map((location) => ({
              uri: monaco.Uri.parse(location.uri),
              range: toRange(location.range),
            }));
        },
      }),
    );

    const legend = initialized.capabilities.semanticTokensProvider?.legend;
    if (legend)
      disposables.push(
        monaco.languages.registerDocumentSemanticTokensProvider(language, {
          getLegend: () => legend,
          provideDocumentSemanticTokens: async (model) => {
            const tokens = await request(() =>
              connection.sendRequest(SemanticTokensRequest.type, {
                textDocument: { uri: model.uri.toString() },
              }),
            );
            return { data: new Uint32Array(tokens?.data ?? []) };
          },
          releaseDocumentSemanticTokens: () => {},
        }),
      );
  });

  return {
    dispose: () => {
      disposed = true;
      for (const disposable of disposables) disposable.dispose();
      for (const model of monaco.editor.getModels())
        if (model.getLanguageId() === language) monaco.editor.setModelMarkers(model, "langkit", []);
      connection.dispose();
    },
  };
};
