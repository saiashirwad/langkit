import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createConnection,
} from "vscode-languageserver/browser";
import { serve } from "langkit/lsp";
import { load, reader, type Setup } from "./languages.ts";

// Inside a worker, self has the same messaging surface as a Worker.
const scope = self as unknown as Worker;

// The first message chooses the language. Everything after it is LSP.
scope.onmessage = async ({ data }: MessageEvent<Setup>) => {
  scope.onmessage = null;
  try {
    const language = await load(data);
    scope.postMessage({ ready: true });
    const connection = createConnection(
      new BrowserMessageReader(scope),
      new BrowserMessageWriter(scope),
    );
    serve(connection, reader(data.files), language.analyze, language.show);
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
