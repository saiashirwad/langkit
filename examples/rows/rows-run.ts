import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { render } from "langkit";
import { compile } from "./rows.ts";

const file = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]))
  : new URL("./main.rows", import.meta.url);
const read = (uri: string): string => readFileSync(new URL(uri), "utf8");
const source = readFileSync(file, "utf8");
const result = compile(source, { uri: file.href, read });
if (!result.success) {
  console.error(render(result.error, source));
  process.exitCode = 1;
} else console.log(runInNewContext(result.value.javascript, { console }, { timeout: 1000 }));
