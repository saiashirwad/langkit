import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDocument } from "vscode-languageserver-textdocument";
import { encodeTokens } from "langkit/lsp";
import { tokenKinds } from "langkit/analysis";

type Message = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type Diagnostics = {
  uri: string;
  version?: number;
  diagnostics: { message: string; range: unknown }[];
};

type Hover = { contents: { kind: string; value: string }; range: unknown } | null;

const client = (
  t: TestContext,
  args = [fileURLToPath(new URL("../examples/toy/toy-lsp.ts", import.meta.url)), "--stdio"],
) => {
  const child = spawn(process.execPath, args, {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const notifications: Message[] = [];
  let wake: (() => void) | undefined;
  let buffer = Buffer.alloc(0);
  let id = 0;

  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const split = buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      const header = buffer.subarray(0, split).toString();
      const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
      assert.ok(Number.isFinite(length), `Invalid LSP header: ${header}`);
      if (buffer.length < split + 4 + length) return;
      // Messages are JSON-RPC frames from the subprocess under test.
      const message = JSON.parse(
        buffer.subarray(split + 4, split + 4 + length).toString(),
      ) as Message;
      buffer = buffer.subarray(split + 4 + length);
      if (message.id !== undefined) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
        else request?.resolve(message.result);
      } else {
        notifications.push(message);
        wake?.();
      }
    }
  });

  child.on("error", (error) => {
    for (const request of pending.values()) request.reject(error);
  });

  child.on("exit", (code) => {
    for (const request of pending.values())
      request.reject(new Error(`Server exited ${code}: ${stderr}`));
    wake?.();
  });

  t.after(() => {
    child.kill();
  });

  const send = (message: object) => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };

  const request = <T = unknown>(method: string, params: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      const current = ++id;
      const timer = setTimeout(() => {
        pending.delete(current);
        reject(new Error(`Timed out waiting for ${method}: ${stderr}`));
      }, 3000);
      pending.set(current, {
        // The caller supplies the expected protocol result shape.
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ id: current, method, params });
    });

  const notification = async <T>(method: string, matches: (value: T) => boolean): Promise<T> => {
    const deadline = Date.now() + 3000;
    while (true) {
      const index = notifications.findIndex(
        (message) => message.method === method && matches(message.params as T),
      );
      if (index >= 0) return notifications.splice(index, 1)[0]!.params as T;
      if (child.exitCode !== null) throw new Error(`Server exited: ${stderr}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${method}: ${stderr}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  };

  return {
    request,
    notify: (method: string, params: unknown) => send({ method, params }),
    diagnostics: (version?: number, uri?: string) =>
      notification<Diagnostics>(
        "textDocument/publishDiagnostics",
        (value) => value.version === version && (!uri || value.uri === uri),
      ),
    shutdown: async () => {
      await request("shutdown", null);
      const exited = once(child, "exit");
      send({ method: "exit" });
      const timeout = setTimeout(() => child.kill(), 3000);
      try {
        assert.equal((await exited)[0], 0, stderr);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
};

const uri = new URL("../examples/editor.toy", import.meta.url).href;

const position = (source: string, offset: number) =>
  TextDocument.create(uri, "toy", 1, source).positionAt(offset);

const at = (source: string, offset: number) => ({
  textDocument: { uri },
  position: position(source, offset),
});

test("stdio LSP: initialize, analyze, edit, clear and shut down", { timeout: 15000 }, async (t) => {
  const server = client(t);
  const initialized = await server.request<{
    capabilities: {
      positionEncoding: string;
      semanticTokensProvider: { legend: { tokenTypes: string[] } };
    };
  }>("initialize", {
    processId: null,
    rootUri: null,
    capabilities: {},
  });
  assert.equal(initialized.capabilities.positionEncoding, "utf-16");
  assert.deepEqual(initialized.capabilities.semanticTokensProvider.legend.tokenTypes, tokenKinds);
  server.notify("initialized", {});
  let source = "let id = fn(x: number) => x in\r\nid(42)";
  server.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "toy", version: 1, text: source },
  });
  assert.deepEqual((await server.diagnostics(1)).diagnostics, []);

  const hover = await server.request<Hover>(
    "textDocument/hover",
    at(source, source.lastIndexOf("id")),
  );
  assert.equal(hover?.contents.kind, "plaintext");
  assert.equal(hover?.contents.value, "(number -> number)");
  const definition = await server.request(
    "textDocument/definition",
    at(source, source.lastIndexOf("id")),
  );
  assert.deepEqual(definition, {
    uri,
    range: { start: { line: 0, character: 4 }, end: { line: 0, character: 6 } },
  });
  const tokens = await server.request<{ data: number[] }>("textDocument/semanticTokens/full", {
    textDocument: { uri },
  });
  assert.ok(tokens.data.length > 0);
  assert.equal(tokens.data.length % 5, 0);
  assert.deepEqual(tokens.data.slice(0, 5), [0, 0, 3, tokenKinds.indexOf("keyword"), 0]);
  assert.ok(
    tokens.data.some((value, index) => index % 5 === 3 && value === tokenKinds.indexOf("function")),
  );

  source = "let x = true in x + 1";
  server.notify("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: source }],
  });
  const errors = (await server.diagnostics(2)).diagnostics;
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /Expected number, found boolean/);
  assert.equal(
    (await server.request<Hover>("textDocument/hover", at(source, source.indexOf("true"))))
      ?.contents.value,
    "boolean",
  );

  server.notify("textDocument/didChange", {
    textDocument: { uri, version: 3 },
    contentChanges: [
      { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 12 } }, text: "41" },
    ],
  });
  assert.deepEqual((await server.diagnostics(3)).diagnostics, []);
  source = "let x = 41 in x + 1";
  assert.equal(
    (await server.request<Hover>("textDocument/hover", at(source, source.indexOf("41"))))?.contents
      .value,
    "number",
  );

  source = "let f = fn(x: number) => x +";
  server.notify("textDocument/didChange", {
    textDocument: { uri, version: 4 },
    contentChanges: [{ text: source }],
  });
  assert.ok((await server.diagnostics(4)).diagnostics.length > 0);
  assert.equal(await server.request("textDocument/definition", at(source, 4)), null);
  assert.equal(await server.request("textDocument/hover", at(source, 4)), null);
  assert.ok(
    (
      await server.request<{ data: number[] }>("textDocument/semanticTokens/full", {
        textDocument: { uri },
      })
    ).data.length > 0,
  );

  server.notify("textDocument/didClose", { textDocument: { uri } });
  assert.deepEqual((await server.diagnostics()).diagnostics, []);
  assert.equal(await server.request("textDocument/hover", at(source, 4)), null);
  assert.equal(await server.request("textDocument/definition", at(source, 4)), null);
  assert.deepEqual(
    await server.request("textDocument/semanticTokens/full", { textDocument: { uri } }),
    { data: [] },
  );
  await server.shutdown();
});

test(
  "schema stdio LSP resolves schema helpers and foreign keys without emitting SQL",
  { timeout: 10000 },
  async (t) => {
    const server = client(t, [
      fileURLToPath(new URL("../examples/schema/schema-lsp.ts", import.meta.url)),
      "--stdio",
    ]);
    await server.request("initialize", { processId: null, capabilities: {} });
    server.notify("initialized", {});
    const source = `let timestamps = fn(model) => model |> extend { createdAt : DateTime |> default now }
model User = { id : Int |> primaryKey } |> timestamps
model Post = { authorId : Int |> references User.id } |> index [.authorId]`;
    const schemaUri = new URL("../examples/editor.schema", import.meta.url).href;
    const document = TextDocument.create(schemaUri, "schema", 1, source);
    const atOffset = (offset: number) => ({
      textDocument: { uri: schemaUri },
      position: document.positionAt(offset),
    });
    server.notify("textDocument/didOpen", {
      textDocument: { uri: schemaUri, languageId: "schema", version: 1, text: source },
    });
    assert.deepEqual((await server.diagnostics(1, schemaUri)).diagnostics, []);
    assert.equal(
      (
        await server.request<Hover>(
          "textDocument/hover",
          atOffset(source.lastIndexOf("timestamps")),
        )
      )?.contents.value,
      "Model -> Model",
    );
    assert.equal(
      (await server.request<Hover>("textDocument/hover", atOffset(source.lastIndexOf("authorId"))))
        ?.contents.value,
      "Int",
    );
    const id = source.indexOf("id :");
    assert.deepEqual(
      await server.request("textDocument/definition", atOffset(source.indexOf("User.id") + 5)),
      {
        uri: schemaUri,
        range: { start: document.positionAt(id), end: document.positionAt(id + 2) },
      },
    );
    const helper = source.indexOf("timestamps");
    assert.deepEqual(
      await server.request("textDocument/definition", atOffset(source.lastIndexOf("timestamps"))),
      {
        uri: schemaUri,
        range: {
          start: document.positionAt(helper),
          end: document.positionAt(helper + "timestamps".length),
        },
      },
    );
    assert.ok(
      (
        await server.request<{ data: number[] }>("textDocument/semanticTokens/full", {
          textDocument: { uri: schemaUri },
        })
      ).data.length > 0,
    );
    server.notify("textDocument/didChange", {
      textDocument: { uri: schemaUri, version: 2 },
      contentChanges: [{ text: "model User = { id : Int } |> index [.missing]" }],
    });
    assert.match(
      (await server.diagnostics(2, schemaUri)).diagnostics[0]!.message,
      /Unknown field: User.missing/,
    );
    await server.shutdown();
  },
);

test(
  "HM stdio LSP specializes uses without losing definition identity",
  { timeout: 10000 },
  async (t) => {
    const server = client(t, [
      fileURLToPath(new URL("../examples/hm/hm-lsp.ts", import.meta.url)),
      "--stdio",
    ]);
    await server.request("initialize", { processId: null, capabilities: {} });
    server.notify("initialized", {});
    const source = "let id = fn(x) => x in if id(true) then id(42) else 0";
    server.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "hm", version: 1, text: source },
    });
    assert.deepEqual((await server.diagnostics(1)).diagnostics, []);
    const booleanUse = source.indexOf("id(true)");
    const numberUse = source.indexOf("id(42)");
    assert.equal(
      (await server.request<Hover>("textDocument/hover", at(source, booleanUse)))?.contents.value,
      "(boolean -> boolean)",
    );
    assert.equal(
      (await server.request<Hover>("textDocument/hover", at(source, numberUse)))?.contents.value,
      "(number -> number)",
    );
    const declaration = {
      uri,
      range: { start: { line: 0, character: 4 }, end: { line: 0, character: 6 } },
    };
    assert.deepEqual(
      await server.request("textDocument/definition", at(source, booleanUse)),
      declaration,
    );
    assert.deepEqual(
      await server.request("textDocument/definition", at(source, numberUse)),
      declaration,
    );
    server.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "fn(x) => x(x)" }],
    });
    assert.equal((await server.diagnostics(2)).diagnostics.length, 1);
    await server.shutdown();
  },
);

test(
  "rows stdio LSP exposes row constraints and analyzes print without executing it",
  { timeout: 10000 },
  async (t) => {
    const server = client(t, [
      fileURLToPath(new URL("../examples/rows/rows-lsp.ts", import.meta.url)),
      "--stdio",
    ]);
    await server.request("initialize", { processId: null, capabilities: {} });
    server.notify("initialized", {});
    const source = 'let get = fn(r) => r.x in print(get({ x = "hello" }))';
    server.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "rows", version: 1, text: source },
    });
    assert.deepEqual((await server.diagnostics(1)).diagnostics, []);
    assert.equal(
      (await server.request<Hover>("textDocument/hover", at(source, 4)))?.contents.value,
      "({ x: a | r } -> a) where r lacks x",
    );
    assert.equal(
      (await server.request<Hover>("textDocument/hover", at(source, source.lastIndexOf("get"))))
        ?.contents.value,
      "({ x: string } -> string)",
    );
    assert.equal(
      await server.request("textDocument/definition", at(source, source.indexOf("print"))),
      null,
    );
    const tokens = await server.request<{ data: number[] }>("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });
    assert.ok(
      tokens.data.some((value, index) => index % 5 === 3 && value === tokenKinds.indexOf("string")),
    );
    server.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "{ x = 1 | { x = 2 } }" }],
    });
    assert.match((await server.diagnostics(2)).diagnostics[0]!.message, /Duplicate field/);
    await server.shutdown();
  },
);

test(
  "advanced stdio LSP exposes higher-rank parameters and exhaustive-match diagnostics",
  { timeout: 10000 },
  async (t) => {
    const server = client(t, [
      fileURLToPath(new URL("../examples/advanced/advanced-lsp.ts", import.meta.url)),
      "--stdio",
    ]);
    await server.request("initialize", { processId: null, capabilities: {} });
    server.notify("initialized", {});
    const prelude = 'import "./advanced/stdlib.advanced";\n';
    const source =
      prelude +
      "let use = fn(f: forall a. a -> a) => if f(true) then f(42) else 0 in print(use(id))";
    server.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "advanced", version: 1, text: source },
    });
    assert.deepEqual((await server.diagnostics(1)).diagnostics, []);
    assert.match(
      (await server.request<Hover>("textDocument/hover", at(source, source.indexOf("use"))))!
        .contents.value,
      /forall/,
    );
    assert.equal(
      (await server.request<Hover>("textDocument/hover", at(source, source.indexOf("f(42)"))))
        ?.contents.value,
      "(number -> number)",
    );
    assert.deepEqual(
      await server.request("textDocument/definition", at(source, source.lastIndexOf("use"))),
      { uri, range: { start: { line: 1, character: 4 }, end: { line: 1, character: 7 } } },
    );
    server.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: prelude + "match Some(42) { Some(value) => value }" }],
    });
    assert.match((await server.diagnostics(2)).diagnostics[0]!.message, /Non-exhaustive.*None/);
    await server.shutdown();
  },
);

test(
  "strict stdio LSP reports inferred constraints and keeps effects inert",
  { timeout: 10000 },
  async (t) => {
    const server = client(t, [
      fileURLToPath(new URL("../examples/strict/strict-lsp.ts", import.meta.url)),
      "--stdio",
    ]);
    await server.request("initialize", { processId: null, capabilities: {} });
    server.notify("initialized", {});
    const prelude = 'import "./strict/stdlib.strict";\n';
    const source = prelude + "keep xs = map id xs; main = do { print (keep (Some 42)); pure {}; };";
    server.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "strict", version: 1, text: source },
    });
    assert.deepEqual((await server.diagnostics(1)).diagnostics, []);
    assert.match(
      (await server.request<Hover>("textDocument/hover", at(source, source.indexOf("keep"))))!
        .contents.value,
      /Functor/,
    );
    assert.match(
      (await server.request<Hover>("textDocument/hover", at(source, source.indexOf("main"))))!
        .contents.value,
      /Effect/,
    );
    assert.deepEqual(
      await server.request("textDocument/definition", at(source, source.lastIndexOf("keep"))),
      { uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } } },
    );
    server.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: prelude + "main : List -> number; main x = 42;" }],
    });
    assert.match((await server.diagnostics(2)).diagnostics[0]!.message, /Kind mismatch/);
    await server.shutdown();
  },
);

test(
  "strict stdlib is an editable module with cross-file definitions and dependent diagnostics",
  { timeout: 15000 },
  async (t) => {
    const server = client(t, [
      fileURLToPath(new URL("../examples/strict/strict-lsp.ts", import.meta.url)),
      "--stdio",
    ]);
    const rootUri = new URL("../examples/strict/editor.strict", import.meta.url).href;
    const libraryUri = new URL("../examples/strict/stdlib.strict", import.meta.url).href;
    const library = readFileSync(new URL(libraryUri), "utf8");
    const source = 'import "./stdlib.strict";\nmain = id 42 + 0;';
    const document = TextDocument.create(rootUri, "strict", 1, source);
    const query = {
      textDocument: { uri: rootUri },
      position: document.positionAt(source.indexOf("id 42")),
    };
    await server.request("initialize", { processId: null, capabilities: {} });
    server.notify("initialized", {});
    server.notify("textDocument/didOpen", {
      textDocument: { uri: rootUri, languageId: "strict", version: 1, text: source },
    });
    assert.deepEqual((await server.diagnostics(1, rootUri)).diagnostics, []);
    const definitionStart = library.indexOf("id x = x;");
    assert.ok(definitionStart >= 0);
    const libraryDocument = TextDocument.create(libraryUri, "strict", 1, library);
    assert.deepEqual(await server.request("textDocument/definition", query), {
      uri: libraryUri,
      range: {
        start: libraryDocument.positionAt(definitionStart),
        end: libraryDocument.positionAt(definitionStart + 2),
      },
    });
    server.notify("textDocument/didOpen", {
      textDocument: { uri: libraryUri, languageId: "strict", version: 1, text: library },
    });
    assert.deepEqual((await server.diagnostics(1, rootUri)).diagnostics, []);
    assert.deepEqual((await server.diagnostics(1, libraryUri)).diagnostics, []);
    const libraryQuery = {
      textDocument: { uri: libraryUri },
      position: libraryDocument.positionAt(definitionStart),
    };
    assert.equal(
      (await server.request<Hover>("textDocument/hover", libraryQuery))?.contents.value,
      "(a -> a)",
    );
    const changed = library.replace("id x = x;", "id x = true;");
    server.notify("textDocument/didChange", {
      textDocument: { uri: libraryUri, version: 2 },
      contentChanges: [{ text: changed }],
    });
    assert.match((await server.diagnostics(1, rootUri)).diagnostics[0]!.message, /Cannot unify/);
    assert.deepEqual((await server.diagnostics(2, libraryUri)).diagnostics, []);
    assert.equal(
      (await server.request<Hover>("textDocument/hover", query))?.contents.value,
      "(number -> boolean)",
    );
    server.notify("textDocument/didClose", { textDocument: { uri: libraryUri } });
    await server.diagnostics(undefined, libraryUri);
    assert.deepEqual((await server.diagnostics(1, rootUri)).diagnostics, []);
    assert.equal(
      (await server.request<Hover>("textDocument/hover", query))?.contents.value,
      "(number -> number)",
    );
    await server.shutdown();
  },
);

test(
  "analyzer exceptions discard old facts without breaking the connection",
  { timeout: 10000 },
  async (t) => {
    const source = `import { serve } from "langkit/lsp";
serve(text => {
  if (text === "bad") throw new Error("broken analyzer");
  return { diagnostics: [], definitions: [], references: [], tokens: [], types: [{ span: { start: 0, end: text.length }, type: "number" }] };
}, type => type);`;
    const server = client(t, ["--input-type=module", "--eval", source]);
    await server.request("initialize", { processId: null, capabilities: {} });
    server.notify("initialized", {});
    server.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "toy", version: 1, text: "good" },
    });
    assert.deepEqual((await server.diagnostics(1)).diagnostics, []);
    assert.equal(
      (await server.request<Hover>("textDocument/hover", at("good", 0)))?.contents.value,
      "number",
    );
    server.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "bad" }],
    });
    assert.match((await server.diagnostics(2)).diagnostics[0]!.message, /Internal analysis error/);
    assert.equal(await server.request("textDocument/hover", at("bad", 0)), null);
    await server.shutdown();
  },
);

test(
  "LSP imports use unsaved buffers, refresh dependents, and navigate across files",
  { timeout: 10000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "langkit-lsp-modules-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const importedUri = pathToFileURL(join(directory, "dep.mini")).href;
    const rootUri = pathToFileURL(join(directory, "main.mini")).href;
    writeFileSync(join(directory, "dep.mini"), "header\n\nlet value = 42");
    const script = `import { serve } from "langkit/lsp";
const dep = ${JSON.stringify(importedUri)};
serve((source, context) => {
  if (context.uri === dep) return { diagnostics: [], definitions: [], references: [], tokens: [], types: [] };
  const imported = context.read(dep);
  const id = Symbol("value");
  const start = imported.indexOf("value");
  return {
    diagnostics: imported.includes("true") ? [{ message: "Expected number", context: [], span: { start: 0, end: 5 } }] : [],
    types: [{ span: { start: 0, end: 5 }, type: imported.includes("true") ? "boolean" : "number" }],
    definitions: [{ id, name: "value", kind: "variable", type: "number", uri: dep, span: { start, end: start + 5 } }],
    references: [{ id, span: { start: 0, end: 5 } }], tokens: [], sources: new Map([[dep, imported]])
  };
}, type => type);`;
    const server = client(t, ["--input-type=module", "--eval", script]);
    await server.request("initialize", { processId: null, capabilities: {} });
    server.notify("initialized", {});
    server.notify("textDocument/didOpen", {
      textDocument: { uri: rootUri, languageId: "mini", version: 1, text: "value + 1" },
    });
    assert.deepEqual((await server.diagnostics(1, rootUri)).diagnostics, []);
    const query = { textDocument: { uri: rootUri }, position: { line: 0, character: 0 } };
    assert.deepEqual(await server.request("textDocument/definition", query), {
      uri: importedUri,
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
    });
    server.notify("textDocument/didOpen", {
      textDocument: { uri: importedUri, languageId: "mini", version: 1, text: "value = true" },
    });
    assert.match((await server.diagnostics(1, rootUri)).diagnostics[0]!.message, /Expected number/);
    assert.equal(
      (await server.request<Hover>("textDocument/hover", query))?.contents.value,
      "boolean",
    );
    await server.diagnostics(1, importedUri);
    server.notify("textDocument/didChange", {
      textDocument: { uri: importedUri, version: 2 },
      contentChanges: [{ text: "\nvalue = 42" }],
    });
    assert.deepEqual((await server.diagnostics(1, rootUri)).diagnostics, []);
    await server.diagnostics(2, importedUri);
    assert.deepEqual(await server.request("textDocument/definition", query), {
      uri: importedUri,
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
    });
    server.notify("textDocument/didClose", { textDocument: { uri: importedUri } });
    await server.diagnostics(undefined, importedUri);
    assert.deepEqual((await server.diagnostics(1, rootUri)).diagnostics, []);
    assert.deepEqual(await server.request("textDocument/definition", query), {
      uri: importedUri,
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
    });
    await server.shutdown();
  },
);

test("semantic tokens sort, split CRLF lines and count astral characters as UTF-16", () => {
  const document = TextDocument.create(uri, "toy", 1, "😀x\r\ny\nz");
  assert.deepEqual(
    encodeTokens(document, [
      { kind: "number", span: { start: 7, end: 8 } },
      { kind: "variable", span: { start: 0, end: 6 } },
    ]),
    [0, 0, 3, 3, 0, 1, 0, 1, 3, 0, 1, 0, 1, 1, 0],
  );
});

test(
  "Ur stdio LSP reports rigid generics, definitions, and overlap errors",
  { timeout: 10000 },
  async (t) => {
    const server = client(t, [
      fileURLToPath(new URL("../examples/ur/ur-lsp.ts", import.meta.url)),
      "--stdio",
    ]);
    await server.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    server.notify("initialized", {});
    const urUri = new URL("../examples/ur/editor.ur", import.meta.url).href;
    const source = "fn identity<A>(value: A) -> A = value;\nlet main = identity(42);";
    const document = TextDocument.create(urUri, "ur", 1, source);
    const atOffset = (offset: number) => ({
      textDocument: { uri: urUri },
      position: document.positionAt(offset),
    });
    server.notify("textDocument/didOpen", {
      textDocument: { uri: urUri, languageId: "ur", version: 1, text: source },
    });
    assert.deepEqual((await server.diagnostics(1, urUri)).diagnostics, []);
    const hover = await server.request<Hover>(
      "textDocument/hover",
      atOffset(source.lastIndexOf("identity")),
    );
    assert.equal(hover?.contents.value, "<A>(A) -> A");
    assert.deepEqual(
      await server.request("textDocument/definition", atOffset(source.lastIndexOf("identity"))),
      {
        uri: urUri,
        range: { start: document.positionAt(3), end: document.positionAt(11) },
      },
    );
    const tokens = await server.request<{ data: number[] }>("textDocument/semanticTokens/full", {
      textDocument: { uri: urUri },
    });
    assert.ok(tokens.data.length > 0);
    server.notify("textDocument/didChange", {
      textDocument: { uri: urUri, version: 2 },
      contentChanges: [{ text: "let main = { x: 1 } ++ { x: true };" }],
    });
    assert.match((await server.diagnostics(2, urUri)).diagnostics[0]!.message, /Overlapping field/);
    await server.shutdown();
  },
);

test("Shapes LSP exposes macro templates, expanded results and lexical definitions", { timeout: 15000 }, async (t) => {
  const server = client(t, [fileURLToPath(new URL('../examples/shapes/shapes-lsp.ts', import.meta.url)), '--stdio']);
  await server.request('initialize', { processId: null, rootUri: null, capabilities: {} });
  server.notify('initialized', {});
  const source = '(macro twice [value] (+ value value))\n(macro four [value] (twice (twice value)))\n(four 10.5)';
  const macroUri = new URL('../examples/shapes/editor.shapes', import.meta.url).href;
  server.notify('textDocument/didOpen', { textDocument: { uri: macroUri, languageId: 'shapes', version: 1, text: source } });
  assert.deepEqual((await server.diagnostics(1, macroUri)).diagnostics, []);
  const location = (offset: number) => ({ textDocument: { uri: macroUri }, position: position(source, offset) });
  const declaration = await server.request<Hover>('textDocument/hover', location(source.indexOf('four')));
  assert.equal(declaration?.contents.value, '(macro four [value]) — expression template; typechecked at use');
  const call = await server.request<Hover>('textDocument/hover', location(source.lastIndexOf('four')));
  assert.equal(call?.contents.value, '(macro four [value]) — expression template; typechecked at use\nExpanded result: number');
  for (const [use, name] of [[source.lastIndexOf('four'), 'four'], [source.lastIndexOf('twice'), 'twice']] as const) {
    const definition = await server.request('textDocument/definition', location(use));
    const start = source.indexOf(name);
    assert.deepEqual(definition, { uri: macroUri, range: { start: position(source, start), end: position(source, start + name.length) } });
  }
  await server.shutdown();
});
