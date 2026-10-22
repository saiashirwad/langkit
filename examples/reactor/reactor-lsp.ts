import { serve } from "langkit/lsp";
import { show } from "../data/data-types.ts";
import { analyze } from "./reactor.ts";

serve(analyze, show);
