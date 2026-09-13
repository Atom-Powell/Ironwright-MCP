import { z } from "zod";
import { unknownPlaceholders } from "./placeholders.js";

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * The named capture groups a pattern declares, or undefined when the pattern
 * will not compile at all -- which `isValidRegex` above has already reported,
 * so there is nothing to add here.
 *
 * Read off the compiled regex rather than scanned out of the source text. An
 * alternation with an empty first branch matches the empty string, and the
 * resulting match carries a key in `groups` for every group the pattern
 * declares, whichever branch actually participated. Scanning the text for
 * "(?<name>" would also count one written inside a character class, where it
 * is not a capture group at all.
 */
function declaredGroupNames(pattern: string): Set<string> | undefined {
  try {
    const groups = new RegExp(`|${pattern}`).exec("")?.groups;
    return new Set(groups === undefined ? [] : Object.keys(groups));
  } catch {
    return undefined;
  }
}

/**
 * What a recognizer's pattern has to capture for the engine to be able to use
 * a match at all, and what that capture feeds.
 *
 * A recognizer without one of these is accepted by every other check and then
 * matches nothing, forever: the parser drops a match with no client and a
 * match with no year, and falls through to the next recognizer. The profile
 * author's file comes back "unrecognized", which reads as the repository
 * being wrong when it is the profile. The deliverable is not on this list
 * because a recognizer declares one of its own.
 *
 * The month is the third member of the class and appears below rather than
 * here, because it is satisfied by either of two group names and this list is
 * one required name per entry. Covering only two of the three would be worse
 * than covering none: an author who has watched the client and year checks
 * fire reads silence about a missing month as approval.
 */
const REQUIRED_RECOGNIZER_CAPTURES: ReadonlyArray<{ name: string; feeds: string }> = [
  { name: "client", feeds: "name the client the file belongs to" },
  { name: "year", feeds: "resolve the period the file covers" },
];

/**
 * A period needs a month as well as a year, and the parser will read it from
 * either a numeric `month` capture or a `monthName` one, so a recognizer has
 * to declare one of the two and never needs both. Real profiles use each:
 * a compact alias captures "202602" as digits, a legacy spaced name captures
 * "February" as a word.
 *
 * Only the declaration is checked. Whether a declared group captures a month
 * that exists is a runtime question the parser already answers, and at the
 * point it decides, an undeclared group and an out-of-range value are the
 * same undefined; conflating the two here would mean reporting a value nobody
 * has read yet.
 */
const MONTH_CAPTURE_ALTERNATIVES = ["month", "monthName"] as const;

export const CadenceSchema = z.enum(["monthly", "quarterly", "semiannual", "annual"]);
export const PeriodAnchorSchema = z.enum(["first", "last"]);
export const VerdictSchema = z.enum(["compliant", "misnamed"]);

export const IdentitySchema = z.object({
  siteUrl: z.string().url(),
  library: z.string().min(1),
  workbookPath: z.string().startsWith("/"),
});

export const TaxonomySchema = z.object({
  segments: z.array(z.string().min(1)).min(1),
});

export const RecognizerSchema = z.object({
  id: z.string().min(1),
  pattern: z.string().min(1).refine(isValidRegex, { message: "must be a valid regular expression" }),
  deliverable: z.string().min(1),
  verdict: VerdictSchema,
});

export const NamingSchema = z.object({
  template: z.string().min(1),
  recognizers: z.array(RecognizerSchema).default([]),
});

export const DeliverableSchema = z.object({
  id: z.string().min(1),
  token: z.string().min(1),
  cadence: CadenceSchema,
  // A taxonomy with a month segment still needs one month to render for a
  // non-monthly period. "last" matches how a report covering a period is
  // produced after that period closes.
  periodAnchor: PeriodAnchorSchema.default("last"),
  appliesTo: z.object({
    workbookField: z.string().min(1),
    truthy: z.literal(true),
  }),
});

export const WorkbookMappingSchema = z.object({
  source: z.object({ kind: z.enum(["table", "worksheet"]), name: z.string().min(1) }),
  headerRow: z.number().int().positive(),
  // `client` is required; any other key is a caller-chosen field name that
  // deliverables and the window reference by key rather than by column header,
  // so renaming a spreadsheet column touches only this mapping.
  columns: z.object({ client: z.string().min(1) }).catchall(z.string().min(1)),
});

export const WindowSchema = z.object({
  mode: z.literal("rolling"),
  months: z.number().int().min(1).max(120),
  respectEffectiveFrom: z.boolean().default(false),
});

export const ProfileSchema = z
  .object({
    profileId: z.string().min(1).regex(/^[a-z0-9-]+$/, "must be lowercase letters, digits, and hyphens"),
    identity: IdentitySchema,
    taxonomy: TaxonomySchema,
    naming: NamingSchema,
    deliverables: z.array(DeliverableSchema).min(1),
    workbookMapping: WorkbookMappingSchema,
    window: WindowSchema,
  })
  .superRefine((profile, ctx) => {
    const custom = z.ZodIssueCode.custom;

    for (const token of unknownPlaceholders(profile.naming.template)) {
      ctx.addIssue({ code: custom, path: ["naming", "template"], message: `unknown placeholder {${token}}` });
    }

    profile.taxonomy.segments.forEach((segment, index) => {
      for (const token of unknownPlaceholders(segment)) {
        ctx.addIssue({ code: custom, path: ["taxonomy", "segments", index], message: `unknown placeholder {${token}}` });
      }
    });

    const deliverableIds = new Set<string>();
    const deliverableTokens = new Set<string>();
    profile.deliverables.forEach((deliverable, index) => {
      if (deliverableIds.has(deliverable.id)) {
        ctx.addIssue({ code: custom, path: ["deliverables", index, "id"], message: `duplicate deliverable id "${deliverable.id}"` });
      }
      deliverableIds.add(deliverable.id);

      // The reconciliation engine maps a token parsed out of a filename back
      // to a deliverable id (a later stage of the engine, not this schema),
      // so two deliverables sharing a token would make that lookup ambiguous
      // with no correct id to return.
      if (deliverableTokens.has(deliverable.token)) {
        ctx.addIssue({ code: custom, path: ["deliverables", index, "token"], message: `duplicate deliverable token "${deliverable.token}"` });
      }
      deliverableTokens.add(deliverable.token);
    });

    const columnKeys = new Set(Object.keys(profile.workbookMapping.columns));
    profile.deliverables.forEach((deliverable, index) => {
      if (!columnKeys.has(deliverable.appliesTo.workbookField)) {
        ctx.addIssue({
          code: custom,
          path: ["deliverables", index, "appliesTo", "workbookField"],
          message: `"${deliverable.appliesTo.workbookField}" is not a key in workbookMapping.columns`,
        });
      }
    });

    const recognizerIds = new Set<string>();
    profile.naming.recognizers.forEach((recognizer, index) => {
      if (recognizerIds.has(recognizer.id)) {
        ctx.addIssue({ code: custom, path: ["naming", "recognizers", index, "id"], message: `duplicate recognizer id "${recognizer.id}"` });
      }
      recognizerIds.add(recognizer.id);

      if (!deliverableIds.has(recognizer.deliverable)) {
        ctx.addIssue({
          code: custom,
          path: ["naming", "recognizers", index, "deliverable"],
          message: `no deliverable is declared with id "${recognizer.deliverable}"`,
        });
      }

      const groups = declaredGroupNames(recognizer.pattern);
      if (groups !== undefined) {
        for (const capture of REQUIRED_RECOGNIZER_CAPTURES) {
          if (groups.has(capture.name)) continue;
          ctx.addIssue({
            code: custom,
            path: ["naming", "recognizers", index, "pattern"],
            message: `recognizer "${recognizer.id}" declares no (?<${capture.name}>...) capture, so no match of it can ${capture.feeds} and the recognizer can never accept a filename: add a (?<${capture.name}>...) group to its pattern`,
          });
        }

        if (!MONTH_CAPTURE_ALTERNATIVES.some((name) => groups.has(name))) {
          ctx.addIssue({
            code: custom,
            path: ["naming", "recognizers", index, "pattern"],
            message: `recognizer "${recognizer.id}" declares no (?<month>...) or (?<monthName>...) capture, so no match of it can resolve the period the file covers and the recognizer can never accept a filename: add a (?<month>...) group for digits, or a (?<monthName>...) group for a month spelled out, to its pattern`,
          });
        }
      }
    });

    if (profile.window.respectEffectiveFrom && !columnKeys.has("effectiveFrom")) {
      ctx.addIssue({
        code: custom,
        path: ["window", "respectEffectiveFrom"],
        message: "requires workbookMapping.columns.effectiveFrom to be mapped",
      });
    }
  });

export type Profile = z.infer<typeof ProfileSchema>;
