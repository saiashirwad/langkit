import { serve } from "langkit/lsp";
import { analyze, show } from "./ur.ts";

serve(analyze, show);
