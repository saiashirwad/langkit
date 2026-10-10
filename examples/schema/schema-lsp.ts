import { serve } from "langkit/lsp";
import { analyze, show } from "./schema.ts";

serve(analyze, show);
