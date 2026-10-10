import { serve } from "langkit/lsp";
import { analyze, show } from "./shapes.ts";

serve(analyze, show);
