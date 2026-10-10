import { serve } from "langkit/lsp";
import { analyze, show } from "./strict.ts";

serve(analyze, show);
