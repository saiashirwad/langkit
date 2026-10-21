import answer from "../advanced/main.advanced";
import {
  compose,
  const as always,
  foldList,
  head,
  type List,
  mapList,
  type Option,
  range,
  withDefault,
} from "../advanced/stdlib.advanced";
import { both, fromList, getValue, sumTree, type Tree } from "../advanced/trees.advanced";

const numbers: List<number> = range(1)(4);
const labels: List<string> = mapList((n: number) => `#${n}`)(numbers);
const first: Option<string> = head(labels);
const total: number = foldList((sum: number) => (n: number) => sum + n)(0)(numbers);
const tree: Tree<number> = fromList(10)(numbers);
const identity = both(<A>(x: A) => x);
const length = compose((s: string) => s.length)(withDefault("none"));
const reading: number = getValue({ value: always(7)("ignored"), unit: "kg" });

console.log(answer, total, sumTree(tree), length(first), identity.value, identity.flag, reading);
