import { z } from "zod";
import { ProfileIdSchema, SiteEntrySchema, refineIdentityAgreesWithSites } from "./base.js";
import { unknownIdPlaceholders, unknownWorkspacePlaceholders } from "../assessment/templates.js";
import { extractPlaceholders } from "./placeholders.js";

const AssessmentSiteEntrySchema = SiteEntrySchema.omit({ workbookPath: true }).strict();
const ColumnName = z.string().min(1).regex(/^[A-Za-z0-9_]+$/, "an internal column name: letters, digits and underscores");
const Template = z.string().min(1);
const Label = z.string().min(1);

/** What SharePoint refuses anywhere in a file or folder name; the slash is the template's own separator. */
const REFUSED_IN_A_NAME = /["*:<>?\\|]/;
/** The same, with the slash, and with what an Azure Table key refuses: the id is also the journal's partition. */
const REFUSED_IN_AN_ID = /["*:<>?/\\|#\u0000-\u001F\u007F-\u009F]/;

/** Artifact kinds the module itself refers to; a profile may add more. */
export const REQUIRED_ARTIFACT_KINDS = ["dossier", "publication"] as const;

export const AssessmentProfileSchema = z
  .object({
    kind: z.literal("assessment"),
    profileId: ProfileIdSchema,
    identity: AssessmentSiteEntrySchema,
    sites: z.array(AssessmentSiteEntrySchema).length(1, "an assessment profile addresses exactly one site in this phase"),
    workspace: z
      .object({
        root: Template.describe('Library-relative folder template of one assessment, for example "Assessments/{vendorFolder}/{assessmentId}". The placeholders are {vendor}, {vendorFolder} and {assessmentId}; there is no date placeholder, because the paths are rendered on every call and a date from the clock would move the folder under an open assessment. Put a date in the assessment id template instead.'),
        subfolders: z.array(Template).default([]).describe('Folders created under the root at open, for example ["Research", "Evidence"].'),
        artifacts: z
          .record(z.string().regex(/^[a-z][a-z0-9_]*$/, "an artifact kind: lowercase letters, digits and underscores"), Template)
          .describe('Named artifact kinds to path templates under the root, for example {"dossier": "Research/{vendor}_Research_Dossier.md"}. "dossier" and "publication" are required. {vendor} renders the vendor name without the characters SharePoint refuses in a file or folder name, as {vendorFolder} does.'),
      })
      .strict(),
    assessmentId: z
      .object({
        prefix: z.string().min(1),
        template: Template.describe(
          'Rendered from the list item id, for example "{prefix}-{yyyy}-{item:5}" giving "ASM-2026-00042". It must contain {item} or {item:N}: the list item id is what makes two assessments differ. The id names a folder and keys the journal, so neither the prefix nor the template may hold a character a folder name or a table key refuses.',
        ),
      })
      .strict(),
    lists: z
      .object({
        vendors: z.object({ name: z.string().min(1), columns: z.object({ folderName: ColumnName }).strict() }).strict(),
        assessments: z
          .object({
            name: z.string().min(1),
            columns: z
              .object({
                assessmentId: ColumnName, vendorFolder: ColumnName, scope: ColumnName, status: ColumnName,
                state: ColumnName, disposition: ColumnName, risk: ColumnName, summary: ColumnName,
              })
              .strict(),
          })
          .strict(),
        findings: z
          .object({
            name: z.string().min(1),
            columns: z.object({ assessmentId: ColumnName, findingKey: ColumnName, observation: ColumnName, risk: ColumnName, recommendation: ColumnName }).strict(),
          })
          .strict(),
      })
      .strict(),
    lifecycle: z
      .object({
        status: z.object({ inProgress: Label, completed: Label, provisional: Label }).strict(),
        dispositions: z.array(Label).min(1),
        risks: z.array(Label).min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    refineIdentityAgreesWithSites(profile, ctx);

    const checkPath = (template: string, path: (string | number)[]): void => {
      for (const token of unknownWorkspacePlaceholders(template)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `"{${token}}" is not a workspace placeholder; the placeholders are {vendor}, {vendorFolder} and {assessmentId}` });
      }
      if (template.startsWith("/")) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "a workspace template is library-relative and does not start with /" });
      // Trimmed as joinWorkspacePath trims a segment, and "." refused with "..": the join throws on
      // either, so a template holding one would load and then fail every call that renders it.
      const segments = template.split("/").map((segment) => segment.trim());
      const dots = segments.find((segment) => segment === "." || segment === "..");
      if (dots !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `a workspace template cannot contain a "${dots}" segment` });
      // The template's own text, placeholders set aside, becomes part of a file or folder name on
      // every call. A character SharePoint refuses there would load and then fail each write at Graph.
      const refused = REFUSED_IN_A_NAME.exec(template.replace(/\{[^}]*\}/g, ""));
      if (refused !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `a workspace template cannot contain "${refused[0]}", which SharePoint refuses in a file or folder name` });
      }
      if (segments.some((segment) => segment.length > 2 && segment.endsWith("."))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "a workspace template has a segment that ends in a dot, which SharePoint refuses in a name" });
      }
    };

    checkPath(profile.workspace.root, ["workspace", "root"]);
    profile.workspace.subfolders.forEach((template, index) => checkPath(template, ["workspace", "subfolders", index]));
    for (const [kind, template] of Object.entries(profile.workspace.artifacts)) checkPath(template, ["workspace", "artifacts", kind]);
    // Two kinds on one file would overwrite each other under either name. Compared without regard
    // to case, as SharePoint compares paths.
    const seenTemplates = new Map<string, string>();
    for (const [kind, template] of Object.entries(profile.workspace.artifacts)) {
      const key = template.split("/").map((segment) => segment.trim()).filter((segment) => segment.length > 0).join("/").toLowerCase();
      const earlier = seenTemplates.get(key);
      if (earlier !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspace", "artifacts", kind], message: `this template names the same file as "${earlier}", and each artifact kind needs its own` });
      } else {
        seenTemplates.set(key, kind);
      }
    }
    for (const kind of REQUIRED_ARTIFACT_KINDS) {
      if (!(kind in profile.workspace.artifacts)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspace", "artifacts", kind], message: `the module needs an artifact kind "${kind}"` });
      }
    }

    for (const token of unknownIdPlaceholders(profile.assessmentId.template)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assessmentId", "template"], message: `"{${token}}" is not an assessment id placeholder; the placeholders are {prefix}, {yyyy}, {mm}, {item} and {item:N}` });
    }

    // The rendered id names a folder, is part of file names, and keys the journal's partition, so
    // it must hold nothing any of the three refuses. Checked here because the alternative is an
    // open that creates the list item and then cannot create its folder or journal its writes.
    const idIssue = (path: string, text: string, what: string): void => {
      const refused = REFUSED_IN_AN_ID.exec(text);
      if (refused !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assessmentId", path], message: `${what} cannot contain "${refused[0]}": the id names a folder and keys the journal, and one of them refuses that character` });
      }
    };
    idIssue("prefix", profile.assessmentId.prefix, "the prefix");
    const idTemplateText = profile.assessmentId.template.replace(/\{[^}]*\}/g, "");
    idIssue("template", idTemplateText, "the template's own text");
    if (!extractPlaceholders(profile.assessmentId.template).some((token) => token === "item" || token.startsWith("item:"))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assessmentId", "template"],
        message: "the template has no {item} or {item:N}, so every assessment would render the same id; the list item id is what makes two differ",
      });
    }
    if (/[.\s]$/.test(profile.assessmentId.template) || /^\s/.test(profile.assessmentId.template)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assessmentId", "template"],
        message: /\.$/.test(profile.assessmentId.template) ? "the template ends in a dot, which SharePoint refuses on the folder the id names" : "the template starts or ends with a space, which a folder name cannot",
      });
    }

    // One list under two roles would mix vendors, assessments and findings in one set of items.
    const listRoles = ["vendors", "assessments", "findings"] as const;
    listRoles.forEach((role, index) => {
      const earlier = listRoles.slice(0, index).find((other) => profile.lists[other].name.toLowerCase() === profile.lists[role].name.toLowerCase());
      if (earlier !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lists", role, "name"], message: `this is the same list as lists.${earlier}, and each of the three needs its own` });
      }
    });

    const labels = Object.values(profile.lifecycle.status);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lifecycle", "status"], message: "the three status labels must differ, or a transition could not be told from the state it leaves" });
    }
  });

export type AssessmentProfile = z.infer<typeof AssessmentProfileSchema>;
