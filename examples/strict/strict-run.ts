import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { render } from "langkit";
import { compile, effectConstructor } from "./strict.ts";
import { decompose } from "./strict-types.ts";

const uri = process.argv[2]
  ? pathToFileURL(resolvePath(process.argv[2])).href
  : new URL("./main.strict", import.meta.url).href;
const read = (uri: string): string => readFileSync(new URL(uri), "utf8");
const source = readFileSync(new URL(uri), "utf8");
const result = compile(source, { uri, read });
if (!result.success) {
  console.error(render(result.error, source));
  process.exitCode = 1;
} else {
  const { head } = decompose(result.value.type);
  if (head.kind === "constructor" && head.constructor.id === effectConstructor.id)
    runInNewContext(`(${result.value.javascript})({})`, { console }, { timeout: 1000 });
  else console.log(runInNewContext(result.value.javascript, { console }, { timeout: 1000 }));
}
