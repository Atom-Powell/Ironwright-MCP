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
    profile.deliverables.forEach((deliverable, index) => {
      if (deliverableIds.has(deliverable.id)) {
        ctx.addIssue({ code: custom, path: ["deliverables", index, "id"], message: `duplicate deliverable id "${deliverable.id}"` });
      }
      deliverableIds.add(deliverable.id);
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
