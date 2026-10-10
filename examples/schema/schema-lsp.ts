import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createConnection } from "vscode-languageserver/node";
import { serve } from "langkit/lsp";
import { analyze, show } from "./schema.ts";

const read = (uri: string): string => {
  const url = new URL(uri);
  if (url.protocol !== "file:") throw new Error("Only local file imports are supported");
  return readFileSync(fileURLToPath(url), "utf8");
};

serve(createConnection(process.stdin, process.stdout), read, analyze, show);
