import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = (name: string) => new URL(`../examples/grammar/${name}`, import.meta.url);

type Position = { readonly line: number; readonly character: number; };
type Location = { readonly uri: string; readonly range: { readonly start: Position; }; };
type Message = {
  readonly id?: number;
  readonly method?: string;
  readonly params?: {
    readonly uri: string;
    readonly diagnostics: readonly { readonly message: string; readonly range: { readonly start: Position; }; }[];
  };
  readonly result?: { readonly contents: { readonly value: string; }; } | readonly Location[] | null;
};

/** The real guest server over stdio, as an editor drives it. */
const server = spawn(process.execPath, ["examples/grammar/grammar-lsp.ts", "--stdio"], { cwd: root });
after(() => server.kill());
const waiting: ((message: Message) => boolean)[] = [];
let buffer = Buffer.alloc(0);
server.stdout.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (let end = buffer.indexOf("\r\n\r\n"); end >= 0; end = buffer.indexOf("\r\n\r\n")) {
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())![1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()) as Message;
    buffer = buffer.subarray(end + 4 + length);
    const index = waiting.findIndex((accepts) => accepts(message));
    if (index >= 0) waiting.splice(index, 1);
  }
});
const send = (message: Record<string, unknown>) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const next = (accepts: (message: Message) => boolean): Promise<Message> =>
  new Promise((resolve) =>
    waiting.push((message) => {
      if (!accepts(message)) return false;
      resolve(message);
      return true;
    })
  );
let sequence = 0;
const request = (method: string, params: unknown) => {
  const id = ++sequence;
  const reply = next((message) => message.id === id);
  send({ id, method, params });
  return reply.then(({ result }) => result);
};
const open = (uri: string, text: string) => {
  const published = next((message) =>
    message.method === "textDocument/publishDiagnostics" && message.params?.uri === uri
  );
  send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "grammar", version: 1, text } } });
  return published.then(({ params }) => params!.diagnostics);
};

const ready = request("initialize", { processId: process.pid, rootUri: null, capabilities: {} }).then(() =>
  send({ method: "initialized", params: {} })
);

const lineOf = (source: string, text: string, from = 0) => {
  const before = source.slice(0, source.indexOf(text, from)).split("\n");
  return { line: before.length - 1, character: before.at(-1)!.length };
};

const domain = readFileSync(file("domain.grammar"), "utf8");
const uri = file("domain.grammar").href;

const hover = async (documentUri: string, position: Position) => {
  const result = await request("textDocument/hover", { textDocument: { uri: documentUri }, position });
  return result && !Array.isArray(result) ? (result as { contents: { value: string; }; }).contents.value : undefined;
};

test("lsp: a clean grammar has no diagnostics, and a label shows the type it projects to", async () => {
  await ready;
  assert.deepEqual(await open(uri, domain), []);
  assert.equal(
    await hover(uri, lineOf(domain, "rest:Port")),
    "readonly [Port, ...Port[]]",
  );
  assert.equal(await hover(uri, lineOf(domain, "Claim =")), "ClaimNever | ClaimPossible | ClaimLeadsTo");
});

test("lsp: a use of a rule or a token goes to its declaration", async () => {
  await ready;
  const definition = async (text: string, within: string): Promise<Position | undefined> => {
    const start = lineOf(domain, text);
    const position = { line: start.line, character: start.character + text.indexOf(within) };
    const result = await request("textDocument/definition", { textDocument: { uri }, position });
    return (result as Location | null)?.range.start;
  };
  assert.deepEqual(await definition("claim:Claim", "Claim"), lineOf(domain, "Claim ="));
  assert.deepEqual(await definition("path:Path", "Path"), lineOf(domain, "Path = /"));
  assert.deepEqual(await definition("first:Port", "Port"), lineOf(domain, "Port = component"));
});

test("lsp: errors in a broken grammar are published at their text, and the rest still has hover", async () => {
  await ready;
  const broken = "grammar G\nA = #n x:B | #m y:A \"!\"\nB = z:ident\nUnused = w:ident\n";
  const brokenUri = file("broken.grammar").href;
  const diagnostics = await open(brokenUri, broken);
  assert.deepEqual(diagnostics.map(({ message, range }) => [message.split(".")[0], range.start]), [
    ["Left recursion: A -> A", lineOf(broken, "A \"!\"")],
    ["Unused rule: Unused is not reachable from A", lineOf(broken, "Unused")],
  ]);
  assert.equal(await hover(brokenUri, lineOf(broken, "x:B")), "B");
});
