import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { Diagnostic } from "../diagnostic.ts";
import { type HostLanguage, project, type Projection } from "../host.ts";
import { place } from "./place.ts";

type MapperDiagnostic = {
  readonly messageText: string;
  readonly start: number;
  readonly length: number;
  readonly code: number;
};

type TransformResult = Projection & {
  readonly extension: ".ts";
  readonly diagnostics: readonly MapperDiagnostic[];
};

type Reply =
  | { readonly result: unknown; }
  | { readonly error: { readonly code: number; readonly message: string; }; };

const emptyModule = "export {};\n";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const mapperDiagnostic = (diagnostic: Diagnostic, uri: string): readonly MapperDiagnostic[] => {
  const site = place(diagnostic, uri);
  if (site.kind === "elsewhere") return [];
  const span = site.span ?? { start: 0, end: 0 };
  return [{ messageText: diagnostic.message, start: span.start, length: span.end - span.start, code: 1 }];
};

const failed = (messageText: string): TransformResult => ({
  text: emptyModule,
  extension: ".ts",
  mappings: [],
  diagnostics: [{ messageText, start: 0, length: 0, code: 1 }],
});

const transform = (
  languages: ReadonlyMap<string, HostLanguage>,
  fileName: string,
  content: string,
): TransformResult => {
  const language = languages.get(extname(fileName));
  if (!language) return failed(`No langkit host is registered for ${extname(fileName)} files`);
  const uri = pathToFileURL(fileName).href;
  try {
    const hosted = language.host(content, uri);
    const { text, mappings } = project(hosted.declarations);
    return {
      text: text || emptyModule,
      extension: ".ts",
      mappings,
      diagnostics: hosted.diagnostics.flatMap((diagnostic) => mapperDiagnostic(diagnostic, uri)),
    };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
};

const reply = (languages: ReadonlyMap<string, HostLanguage>, method: string, params: unknown): Reply => {
  switch (method) {
    case "initialize":
      return { result: { positionEncoding: "utf-16", diagnosticSource: "langkit" } };
    case "openProject":
      return { result: {} };
    case "closeProject":
      return { result: null };
    case "transform":
      return isRecord(params) && typeof params.fileName === "string" && typeof params.content === "string"
        ? { result: transform(languages, params.fileName, params.content) }
        : { error: { code: -32602, message: "transform expects { fileName, content }" } };
    default:
      return { error: { code: -32601, message: `Unsupported method ${method}` } };
  }
};

export const serveContentMapper = (
  languages: readonly HostLanguage[],
  io: { readonly input: NodeJS.ReadableStream; readonly output: NodeJS.WritableStream; } = {
    input: process.stdin,
    output: process.stdout,
  },
): void => {
  const registry = new Map<string, HostLanguage>(languages.map((language) => [language.extension, language]));
  const send = (message: Record<string, unknown>) => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    io.output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const receive = (body: string) => {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      send({ id: null, error: { code: -32700, message: "Invalid JSON" } });
      return;
    }
    if (!isRecord(message) || typeof message.method !== "string" || message.id === undefined) return;
    send({ id: message.id, ...reply(registry, message.method, message.params) });
  };
  let pending = Buffer.alloc(0);
  io.input.on("data", (chunk: Buffer | string) => {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    while (true) {
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = /Content-Length: *(\d+)/i.exec(pending.subarray(0, end).toString())?.[1];
      if (length === undefined) {
        pending = pending.subarray(end + 4);
        continue;
      }
      const stop = end + 4 + Number(length);
      if (pending.length < stop) return;
      const body = pending.subarray(end + 4, stop).toString("utf8");
      pending = pending.subarray(stop);
      receive(body);
    }
  });
};
