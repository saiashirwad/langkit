import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import { runInNewContext } from "node:vm";
import { render } from "langkit";
import { compile } from "./advanced.ts";

const file = process.argv[2]
  ? pathToFileURL(resolvePath(process.argv[2]))
  : new URL("./main.advanced", import.meta.url);
const read = (uri: string): string => readFileSync(new URL(uri), "utf8");
const source = readFileSync(file, "utf8");
const result = compile(source, { uri: file.href, read });
if (!result.success) {
  console.error(render(result.error, source));
  process.exitCode = 1;
} else console.log(runInNewContext(result.value.javascript, { console }, { timeout: 1000 }));
