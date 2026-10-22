import { serve } from "langkit/lsp";
import { analyze, show } from "./machine.ts";

serve(analyze, show);
