import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = (name: string) => new URL(`../examples/domain/${name}`, import.meta.url);

type Position = { readonly line: number; readonly character: number; };
type Location = { readonly uri: string; readonly range: { readonly start: Position; }; };
type Published = {
  readonly uri: string;
  readonly diagnostics: readonly {
    readonly message: string;
    readonly range: { readonly start: Position; };
    readonly relatedInformation?: readonly { readonly location: Location; }[];
  }[];
};
type Message = {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Published;
  readonly result?: { readonly contents: { readonly value: string; }; };
};

/** The real guest server over stdio, as an editor drives it. */
const server = spawn(process.execPath, ["examples/domain/domain-lsp.ts", "--stdio"], { cwd: root });
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
  send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "domain", version: 1, text } } });
  return published.then(({ params }) => params!.diagnostics);
};

const ready = request("initialize", { processId: process.pid, rootUri: null, capabilities: {} }).then(() =>
  send({ method: "initialized", params: {} })
);

const shop = readFileSync(file("shop.domain"), "utf8");
const lineOf = (source: string, text: string) => {
  const before = source.slice(0, source.indexOf(text)).split("\n");
  return { line: before.length - 1, character: before.at(-1)!.length };
};

test("lsp: the failing property is red in the editor, with related rows into the machines' files", async () => {
  await ready;
  const diagnostics = await open(file("shop.domain").href, shop);
  assert.equal(diagnostics.length, 1);
  const [error] = diagnostics;
  assert.equal(error!.message, "refundsNeverShip fails in 5 steps: warehouse is Dispatched and payment is Refunded");
  assert.deepEqual(error!.range.start, lineOf(shop, "refundsNeverShip"));
  const related = error!.relatedInformation ?? [];
  const uris = related.map(({ location }) => location.uri.split("/").at(-1));
  assert.deepEqual(uris, [
    "shop.domain",
    "shop.domain",
    "shop.domain",
    "order.domain",
    "shop.domain",
    "fulfilment.domain",
  ]);
  const order = readFileSync(file("order.domain"), "utf8");
  assert.deepEqual(related[3]!.location.range.start, lineOf(order, "|> on cancel -> Refunding"));

  const hover = async (text: string) =>
    (await request("textDocument/hover", {
      textDocument: { uri: file("shop.domain").href },
      position: lineOf(shop, text),
    }))!.contents.value;
  assert.equal(
    await hover("refundsNeverShip"),
    "property refundsNeverShip = never (warehouse is Dispatched and payment is Refunded)\nfails: see the error on this name",
  );
  assert.equal(
    await hover("settles"),
    "property settles = order is Paid ~> order is Delivered | Cancelled\nholds in 23 states",
  );
});

test("lsp: a system past the editor budget is an error at its name, not a frozen editor", async () => {
  await ready;
  const counter = (name: string) =>
    `machine ${name} { event step initial state S0 |> on step -> S1 ${
      [1, 2, 3, 4].map((n) => `state S${n} |> on step -> S${n + 1}`).join(" ")
    } state S5 |> on step -> S0 }\n`;
  const names = ["A", "B", "C", "D", "E", "F"];
  const source = names.map(counter).join("")
    + `system Wide = { ${names.map((name) => `${name.toLowerCase()} : ${name}`).join(", ")} }\n`;
  const diagnostics = await open(file("wide.domain").href, source);
  assert.deepEqual(diagnostics.map(({ message }) => message), [
    "Wide is too large to check: more than 20000 reachable states; pnpm domain checks it with a larger limit",
  ]);
});
