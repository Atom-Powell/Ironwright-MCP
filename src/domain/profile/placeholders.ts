/**
 * The closed set of tokens a taxonomy segment or filename template may use.
 * Keeping it closed means a typo in a profile is a validation error rather than
 * a path that renders with a literal brace and silently never matches a file.
 */
export const PLACEHOLDERS = ["year", "month", "month:02", "monthName", "client", "deliverable"] as const;

export type Placeholder = (typeof PLACEHOLDERS)[number];

// Exported so the renderer extracts tokens with the exact same pattern the
// validator uses to find them. Two regexes that are supposed to agree on what
// counts as a token are one edit away from drifting if either module keeps
// its own copy.
export const TOKEN_PATTERN = /\{([^}]*)\}/g;

export function extractPlaceholders(template: string): string[] {
  return [...template.matchAll(TOKEN_PATTERN)].map((match) => match[1] ?? "");
}

export function unknownPlaceholders(template: string): string[] {
  const supported = new Set<string>(PLACEHOLDERS);
  return extractPlaceholders(template).filter((token) => !supported.has(token));
}
