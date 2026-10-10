import { serve } from "langkit/lsp";
import { analyze, show } from "./hm.ts";

serve(analyze, show);
