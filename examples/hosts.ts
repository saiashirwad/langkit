import type { HostLanguage } from "langkit/host";
import { host as advanced } from "./advanced/advanced-host.ts";
import { host as domain } from "./domain/domain-host.ts";
import { host as grammar } from "./grammar/grammar-host.ts";
import { host as hm } from "./hm/hm-host.ts";
import { host as reactor } from "./reactor/reactor-host.ts";
import { host as schema } from "./schema/schema-host.ts";
import { host as toy } from "./toy/toy-host.ts";

export const hosts: readonly HostLanguage[] = [
  toy,
  hm,
  schema,
  domain,
  advanced,
  grammar,
  reactor,
];
