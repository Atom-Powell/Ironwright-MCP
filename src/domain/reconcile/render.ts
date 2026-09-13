import type { Placeholder } from "../profile/placeholders.js";
import { monthName } from "./months.js";
import type { Period } from "./types.js";

export interface RenderContext {
  period: Period;
  client: string;
  deliverable: string;
}

const TOKEN_PATTERN = /\{([^}]*)\}/g;

// Keyed by the Placeholder union from the profile validator's own token set,
// with every member required, so adding a token there without a resolver here
// (or vice versa) is a compile error rather than a profile that validates but
// renders wrong, or a template the renderer accepts that the validator rejects.
const RESOLVERS: Record<Placeholder, (context: RenderContext) => string> = {
  year: (context) => String(context.period.year),
  month: (context) => String(context.period.month),
  "month:02": (context) => String(context.period.month).padStart(2, "0"),
  monthName: (context) => monthName(context.period.month),
  client: (context) => context.client,
  deliverable: (context) => context.deliverable,
};

// The Record above already covers every Placeholder; this is just how
// RESOLVERS gets indexed by an arbitrary string captured out of a template.
const resolverByToken = RESOLVERS as Record<string, ((context: RenderContext) => string) | undefined>;

/**
 * Renders a single template string. This function, applied to
 * `profile.naming.template`, is the entire definition of the canonical
 * filename: nothing else in the engine independently decides what canonical
 * looks like, so the filename parser (a later task) builds its matcher by
 * converting this same template into capture groups rather than restating it.
 */
export function renderTemplate(template: string, context: RenderContext): string {
  return template.replace(TOKEN_PATTERN, (_match, token: string) => {
    const resolve = resolverByToken[token];
    if (!resolve) {
      // The profile validator already rejects unknown tokens against this
      // same PLACEHOLDERS set, so reaching this line means a bug upstream,
      // not a bad profile. Throwing instead of rendering the brace literally
      // stops a path that can never match anything from being produced quietly.
      throw new Error(`unknown placeholder {${token}}`);
    }
    return resolve(context);
  });
}

/** Renders each taxonomy segment and joins them into a library-relative path. */
export function renderPath(segments: string[], context: RenderContext): string {
  return segments.map((segment) => renderTemplate(segment, context)).join("/");
}
