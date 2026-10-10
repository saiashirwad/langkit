export type Span = { readonly start: number; readonly end: number }

export type Diagnostic = {
  readonly message: string
  readonly context: readonly string[]
  readonly span?: Span
}

export const render = (error: Diagnostic, source?: string): string => {
  const context = error.context.length ? `\nWhile checking: ${error.context.join(" > ")}` : ""
  if (source === undefined || error.span === undefined) return error.message + context
  const { start, end } = error.span
  const before = source.slice(0, start).split("\n")
  const line = before.length
  const column = before.at(-1)!.length
  const text = source.split("\n")[line - 1] ?? ""
  const underline = "^".repeat(Math.max(1, Math.min(end - start, text.length - column)))
  return [
    `line ${line}, column ${column + 1}: ${error.message}`,
    text,
    " ".repeat(column) + underline + context
  ].join("\n")
}
