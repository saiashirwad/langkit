import { serve } from "langkit/lsp";
import { analyze } from "./domain.ts";
import { show } from "./scope.ts";

serve(analyze, show);
