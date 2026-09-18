import { TOKEN_PATTERN } from "../profile/placeholders.js";
// Imported through the engine's one entry point rather than "./months.js"
// directly: the lint rule that enforces that entry point applies inside the
// rest of the domain layer too, and MONTH_NAMES is re-exported there for
// exactly this reason. See the comment on that export.
import { MONTH_NAMES } from "../reconcile/index.js";
import type { Profile } from "../profile/schema.js";

// Escapes everything a regex special-cases so a taxonomy segment's literal
// text (a dot, a plus, whatever a customer's own segment naming happens to
// use) is matched byte for byte rather than interpreted as a pattern.
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One pattern per placeholder, matching exactly what `render.ts` can produce
 * for that token and nothing else. `{client}` is the exception: the renderer
 * emits a client's own name and this checker is asked about clients it has not
 * been given, so it accepts any segment that is not empty and holds no
 * separator.
 */
function patternFor(token: string, deliverableTokens: readonly string[]): string {
  switch (token) {
    case "year":
      return "\\d{4}";
    case "month":
      return "(?:[1-9]|1[0-2])";
    case "month:02":
      return "(?:0[1-9]|1[0-2])";
    case "monthName":
      return `(?:${MONTH_NAMES.join("|")})`;
    case "deliverable":
      return `(?:${deliverableTokens.map(escapeLiteral).join("|")})`;
    case "client":
      return "[^/]+";
    default:
      // The profile validator rejects an unknown token against this same set,
      // so reaching here means a bug upstream, not a bad profile.
      throw new Error(`unknown placeholder {${token}}`);
  }
}

// Builds one anchored pattern per taxonomy segment, turning the segment's
// literal text and its placeholders into a single regex. Anchoring at both
// ends here, once, is what stops a longer segment such as "2026x" from
// passing a "{year}" match: this repository has shipped that exact defect
// twice as an unanchored or prefix comparison, in empty-folders.ts and
// snapshot.ts.
function segmentRegex(segment: string, deliverableTokens: readonly string[]): RegExp {
  let source = "";
  let cursor = 0;
  for (const match of segment.matchAll(TOKEN_PATTERN)) {
    source += escapeLiteral(segment.slice(cursor, match.index));
    source += patternFor(match[1] ?? "", deliverableTokens);
    cursor = (match.index ?? 0) + match[0].length;
  }
  source += escapeLiteral(segment.slice(cursor));
  return new RegExp(`^${source}$`);
}

/**
 * Builds a predicate that answers one question only: is this library-relative
 * path shaped like a path the taxonomy could have produced. It says nothing
 * about whether a client is compliant, whether a deliverable is owed, or
 * whether a file is missing -- those verdicts belong to the reconciliation
 * engine's single entry point, and this function is not it.
 */
export function buildTaxonomyMatcher(profile: Profile): (relativePath: string) => boolean {
  const deliverableTokens = profile.deliverables.map((deliverable) => deliverable.token);
  const patterns = profile.taxonomy.segments.map((segment) => segmentRegex(segment, deliverableTokens));

  return (relativePath: string): boolean => {
    const segments = relativePath.split("/");
    // A path deeper than the taxonomy has segments is never a taxonomy path,
    // regardless of whether its first segments would each match on their own.
    if (segments.length === 0 || segments.length > patterns.length) return false;
    return segments.every((segment, index) => patterns[index]!.test(segment));
  };
}
