import type { HostLanguage } from "langkit/host";
import { host as hm } from "./hm/hm-host.ts";
import { host as schema } from "./schema/schema-host.ts";
import { host as toy } from "./toy/toy-host.ts";

export const hosts: readonly HostLanguage[] = [
  toy,
  hm,
  schema,
  // rows: row absence (`r \ l`) does not survive TypeScript width subtyping
  // strict: type classes need higher-kinded types TypeScript lacks
  // ur: disjointness and exact rows are not enforceable under TypeScript subtyping
  // shapes: row replacement and provenance have no faithful TypeScript form
];
