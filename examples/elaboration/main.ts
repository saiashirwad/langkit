import { runInNewContext } from "node:vm";
import { render } from "../../src/diagnostic.ts";
import { hm, higherRank } from "./mini.ts";

const compiler = process.argv[2] === "higher-rank" ? higherRank : hm;
const source = process.argv[3] ?? "let id = fn x => x; (id(1), id(true))";
const outcome = compiler.elaborate(source);
if (outcome.status === "checked") {
  const javascript = compiler.emit(outcome.artifact);
  console.log(outcome.partial.type);
  console.log(javascript);
  console.log(runInNewContext(javascript, {}, { timeout: 1000 }));
} else {
  for (const diagnostic of outcome.diagnostics) console.error(render(diagnostic, source));
  process.exitCode = 1;
}
