import { readFileSync } from "node:fs";
import {
  type Declaration,
  type Member,
  parse,
  type Port,
  type SystemClause,
  type SystemClauseSync,
} from "../grammar/domain.grammar";

const parsed = parse(readFileSync(new URL("../domain/shop.domain", import.meta.url), "utf8"));
if (!parsed.success) throw new Error(parsed.errors[0].message);

const show = ({ component, event }: Port) => `${component.name}.${event.name}`;

const syncs = (clause: SystemClause): readonly string[] =>
  clause.kind === "sync" ? [[clause.first, ...clause.rest].map(show).join(" = ")] : [];

for (const declaration of parsed.value.declarations) {
  if (declaration.kind !== "system") continue;
  const parts = declaration.parts.components.map(({ name, machine }) => `${name.name}: ${machine.name}`);
  console.log(declaration.name.name, parts.join(", "));
  for (const clause of declaration.clauses) for (const line of syncs(clause)) console.log(line);
}

// @ts-expect-error A sync clause names at least two ports, so more than one follows its first.
const alone = (clause: SystemClauseSync): readonly [Port] => clause.rest;

// @ts-expect-error Only a system declaration has parts.
const partsOf = (declaration: Declaration) => declaration.parts;

// @ts-expect-error A union member written without a payload has no fields.
const payloadSize = (member: Member) => member.fields.length;

void alone, partsOf, payloadSize;
