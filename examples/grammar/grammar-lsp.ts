import { serve } from "langkit/lsp";
import { analyze, show } from "./grammar.ts";

serve(analyze, show);
