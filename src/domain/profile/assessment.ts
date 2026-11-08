import { z } from "zod";
import { ProfileIdSchema, SiteEntrySchema, refineIdentityAgreesWithSites } from "./base.js";
import { unknownIdPlaceholders, unknownWorkspacePlaceholders } from "../assessment/templates.js";

const AssessmentSiteEntrySchema = SiteEntrySchema.omit({ workbookPath: true }).strict();
const ColumnName = z.string().min(1).regex(/^[A-Za-z0-9_]+$/, "an internal column name: letters, digits and underscores");
const Template = z.string().min(1);
const Label = z.string().min(1);

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
          .describe('Named artifact kinds to path templates under the root, for example {"dossier": "Research/{vendor}_Research_Dossier.md"}. "dossier" and "publication" are required.'),
      })
      .strict(),
    assessmentId: z
      .object({
        prefix: z.string().min(1),
        template: Template.describe(
          'Rendered from the list item id, for example "{prefix}-{yyyy}-{item:5}" giving "ASM-2026-00042". A template without {item} is not unique by construction; the list item id is what makes two assessments differ.',
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
      if (template.split("/").some((segment) => segment === "..")) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "a workspace template cannot contain a .. segment" });
    };

    checkPath(profile.workspace.root, ["workspace", "root"]);
    profile.workspace.subfolders.forEach((template, index) => checkPath(template, ["workspace", "subfolders", index]));
    for (const [kind, template] of Object.entries(profile.workspace.artifacts)) checkPath(template, ["workspace", "artifacts", kind]);
    for (const kind of REQUIRED_ARTIFACT_KINDS) {
      if (!(kind in profile.workspace.artifacts)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspace", "artifacts", kind], message: `the module needs an artifact kind "${kind}"` });
      }
    }

    for (const token of unknownIdPlaceholders(profile.assessmentId.template)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assessmentId", "template"], message: `"{${token}}" is not an assessment id placeholder; the placeholders are {prefix}, {yyyy}, {mm}, {item} and {item:N}` });
    }

    const labels = Object.values(profile.lifecycle.status);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lifecycle", "status"], message: "the three status labels must differ, or a transition could not be told from the state it leaves" });
    }
  });

export type AssessmentProfile = z.infer<typeof AssessmentProfileSchema>;
