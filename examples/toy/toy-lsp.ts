import { serve } from "langkit/lsp"
import { analyze, show } from "./toy.ts"

serve(analyze, show)
