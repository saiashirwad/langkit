import { serve } from "langkit/lsp";
import { analyze, show } from "./rows.ts";

serve(analyze, show);
