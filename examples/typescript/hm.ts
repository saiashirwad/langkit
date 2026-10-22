import compose from "../hm/compose.hm";
import answer from "../hm/main.hm";
import twice from "../hm/twice.hm";

const total: number = answer;
const isLong: (x: string) => boolean = compose((n: number) => n > 3)((s: string) => s.length);
const stepped: number = twice((n: number) => n + 2)(1);
const shouted: string = twice((s: string) => `${s}!`)("hey");

console.log(total, isLong("four"), stepped, shouted);
