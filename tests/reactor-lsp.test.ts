import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = (name: string) => new URL(`../examples/reactor/${name}`, import.meta.url);

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
const server = spawn(process.execPath, ["examples/reactor/reactor-lsp.ts", "--stdio"], { cwd: root });
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
  send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "reactor", version: 1, text } } });
  return published.then(({ params }) => params!.diagnostics);
};

const ready = request("initialize", { processId: process.pid, rootUri: null, capabilities: {} }).then(() =>
  send({ method: "initialized", params: {} })
);

const lineOf = (source: string, text: string, from = 0) => {
  const before = source.slice(0, source.indexOf(text, from)).split("\n");
  return { line: before.length - 1, character: before.at(-1)!.length };
};

const player = readFileSync(file("player.reactor"), "utf8");
const uri = file("player.reactor").href;

const hover = async (documentUri: string, position: Position) => {
  const result = await request("textDocument/hover", { textDocument: { uri: documentUri }, position });
  return result && !Array.isArray(result) ? (result as { contents: { value: string; }; }).contents.value : undefined;
};

const shifted = (position: Position, characters: number): Position => ({
  ...position,
  character: position.character + characters,
});

test("lsp: the player has no diagnostics, and hover shows a rest narrowed by the rows above", async () => {
  await ready;
  assert.deepEqual(await open(uri, player), []);
  assert.equal(await hover(uri, shifted(lineOf(player, "[..s]  "), 3)), "s : [Step; ..2]");
  assert.equal(await hover(uri, lineOf(player, "steps :")), "cell steps : [Step; ..3]");
});

test("lsp: a name in a pattern goes to the binder it compares with", async () => {
  await ready;
  const position = shifted(lineOf(player, "Loop(c)"), 5);
  const result = await request("textDocument/definition", { textDocument: { uri }, position });
  assert.deepEqual((result as Location | null)?.range.start, shifted(lineOf(player, "on clip c"), 8));
});

test("lsp: deleting the [a, b, _] row publishes the overflow at the row that can overflow", async () => {
  await ready;
  const broken = player.replace("      [a, b, _]            ->  [a, b, Loop(c)]\n", "");
  const diagnostics = await open(file("broken.reactor").href, broken);
  assert.deepEqual(diagnostics.map(({ message, range }) => [message, range.start]), [
    [
      "steps holds at most 3, but this row can make it hold 4",
      lineOf(broken, "[..s, Loop(c)]", broken.indexOf("[..s]  ")),
    ],
  ]);
});
