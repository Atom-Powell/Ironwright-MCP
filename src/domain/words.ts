/**
 * A list as a person would say it: "a", "a and b", "a, b and c". For the
 * messages an operator reads, where a chain of "and" reads as a mistake.
 */
export function inWords(names: readonly string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}
