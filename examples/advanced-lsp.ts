import { serve } from "langkit/lsp";
import { analyze, show } from "./advanced.ts";

serve(analyze, show);
