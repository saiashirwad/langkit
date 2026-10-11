/**
 * Resolve a mutable inference-variable link and compress its path.
 *
 * The callbacks keep the helper independent of any language's type, row, or
 * variable representation. A variable with no instance is returned unchanged.
 */
export const pruneLink = <T, V extends object>(
  value: T,
  variable: (value: T) => V | null,
  instance: (variable: V) => T | undefined,
  link: (variable: V, value: T) => void,
): T => {
  const node = variable(value);
  if (!node) return value;
  const target = instance(node);
  if (target === undefined) return value;
  const pruned = pruneLink(target, variable, instance, link);
  link(node, pruned);
  return pruned;
};
