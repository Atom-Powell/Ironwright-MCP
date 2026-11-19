import { z } from "zod";
import { ProfileIdSchema, SiteEntrySchema, refineIdentityAgreesWithSites } from "./base.js";
import { firstRefusedNameCharacter, unknownIdPlaceholders, unknownWorkspacePlaceholders } from "../assessment/templates.js";
import { extractPlaceholders } from "./placeholders.js";

const AssessmentSiteEntrySchema = SiteEntrySchema.omit({ workbookPath: true }).strict();
const ColumnName = z.string().min(1).regex(/^[A-Za-z0-9_]+$/, "an internal column name: letters, digits and underscores");
const Template = z.string().min(1);
const Label = z.string().min(1);

/**
 * What an Azure Table key refuses beyond what a SharePoint name already does. The assessment id is
 * also the journal's partition, so an id must clear both. The store's own rule is FORBIDDEN in
 * src/store/keys.ts, which this layer cannot import; a test holds the two together.
 */
const REFUSED_IN_A_KEY = /[#\u0000-\u001F\u007F-\u009F]/;

const Kind = z.string().regex(/^[a-z][a-z0-9_]*$/, "an artifact kind: lowercase letters, digits and underscores");

/**
 * The vendor risk workflow, which is what a profile gets when it says nothing
 * about its lifecycle: findings and a provisional status wait on the dossier,
 * completion waits on the dossier and the publication, the publication is
 * produced outside this server, and a dossier saved a second time is a
 * correction. Stated once, so the defaults and the messages that explain them
 * cannot drift apart.
 */
const DEFAULT_GATES = { findings: ["dossier"], provisional: ["dossier"], completed: ["dossier", "publication"] };
const DEFAULT_EXTERNAL = ["publication"];
const DEFAULT_CORRECTED = ["dossier"];

/**
 * The gates default as a whole, not key by key: a profile that sets one stage's
 * gate and inherited another workflow's for the rest would be half one
 * workflow and half another. So a gate left out is refused, in these words,
 * where Zod alone would say only "Required".
 */
const GATE_MISSING = { required_error: "a profile that sets gates sets all three, findings, provisional and completed; leave gates out entirely for the default workflow" };

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
          .describe('Named artifact kinds to path templates under the root, for example {"dossier": "Research/{vendor}_Research_Dossier.md"}. Every kind the lifecycle names must be defined here, which by default means "dossier" and "publication". {vendor} renders the vendor display name with the characters SharePoint refuses in a name removed and nothing else changed, so it cannot end a path segment. {vendorFolder} is the folder name, which also loses a trailing dot.'),
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
        // Optional: named, the journal is kept in this list on the workflow's own site, so it
        // survives a restart with no table store; left out, it is kept in the state store as before.
        // docs/superpowers/specs/2026-11-18-journal-in-a-sharepoint-list-design.md
        journal: z
          .object({
            name: z.string().min(1),
            columns: z
              .object({
                assessmentId: ColumnName, at: ColumnName, correlationId: ColumnName, stage: ColumnName, operation: ColumnName, target: ColumnName,
                etagBefore: ColumnName, etagAfter: ColumnName, contentHash: ColumnName, priorContentHash: ColumnName, versionId: ColumnName,
              })
              .strict(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    lifecycle: z
      .object({
        status: z.object({ inProgress: Label, completed: Label, provisional: Label }).strict(),
        dispositions: z.array(Label).min(1),
        risks: z.array(Label).min(1),
        gates: z
          .object({
            findings: z.array(Kind, GATE_MISSING).describe('Artifact kinds that must be present before record_findings writes, for example ["dossier"], or ["intake"] for a client onboarding. May be empty.'),
            provisional: z.array(Kind, GATE_MISSING).describe('Artifact kinds that must be present before a transition to the provisional status, for example ["dossier"]. May be empty.'),
            completed: z
              .array(Kind, GATE_MISSING)
              .min(1, "the completed gate names at least one artifact kind, or completion would be verified against nothing")
              .describe('Artifact kinds that must be present before a transition to the completed status, for example ["dossier", "publication"].'),
          })
          .strict()
          .default(DEFAULT_GATES)
          .describe("Which artifact kinds each stage waits on. The code holds no kind's name: a workflow is whatever its profile gates. Defaults to the vendor risk workflow."),
        external: z
          .array(Kind)
          .default(DEFAULT_EXTERNAL)
          .describe('Artifact kinds produced outside this server, by a person or a publisher, for example ["publication"] or ["handover"]. save_assessment_artifact refuses them and verify_publication reads them. May be empty.'),
        corrected: z
          .array(Kind)
          .default(DEFAULT_CORRECTED)
          .describe('Artifact kinds whose overwrite is recorded as the CORRECTION stage, not as the kind\'s own, for example ["dossier"]. May be empty.'),
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
      // Segment by segment, since the slash between them is the template's own separator.
      const refused = segments.map((segment) => firstRefusedNameCharacter(segment.replace(/\{[^}]*\}/g, ""))).find((character) => character !== undefined);
      if (refused !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `a workspace template cannot contain "${refused}", which SharePoint refuses in a file or folder name` });
      }
      if (segments.some((segment) => segment !== "." && segment !== ".." && segment.endsWith("."))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "a workspace template has a segment that ends in a dot, which SharePoint refuses in a name" });
      }
      // {vendor} keeps a dot the display name ends in, because inside a file name it is legal. At
      // the end of a segment it would end the name, which SharePoint refuses.
      if (segments.some((segment) => segment.endsWith("{vendor}"))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: "{vendor} ends a path segment, and a display name can end in a dot, which SharePoint refuses at the end of a name; put text after it or use {vendorFolder}",
        });
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
    // Every kind the lifecycle names has to be one the workspace gives a path. A gate on a kind
    // with no path would load and then refuse its stage forever, naming a file nothing can find.
    // Each message says what the setting defaults to, because a profile that sets nothing is told
    // about a setting it never wrote.
    const kinds = Object.keys(profile.workspace.artifacts);
    const named: Array<[(string | number)[], readonly string[], string]> = [
      [["lifecycle", "gates", "findings"], profile.lifecycle.gates.findings, `When the profile sets no gates, this one defaults to ${DEFAULT_GATES.findings.join(" and ")}.`],
      [["lifecycle", "gates", "provisional"], profile.lifecycle.gates.provisional, `When the profile sets no gates, this one defaults to ${DEFAULT_GATES.provisional.join(" and ")}.`],
      [["lifecycle", "gates", "completed"], profile.lifecycle.gates.completed, `When the profile sets no gates, this one defaults to ${DEFAULT_GATES.completed.join(" and ")}.`],
      [["lifecycle", "external"], profile.lifecycle.external, `When the profile does not set it, external defaults to ${DEFAULT_EXTERNAL.join(" and ")}.`],
      [["lifecycle", "corrected"], profile.lifecycle.corrected, `When the profile does not set it, corrected defaults to ${DEFAULT_CORRECTED.join(" and ")}.`],
    ];
    for (const [path, list, fallback] of named) {
      for (const kind of list) {
        if (!kinds.includes(kind)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `names the artifact kind "${kind}", which workspace.artifacts does not define; its kinds are ${kinds.join(", ")}. ${fallback}`,
          });
        }
      }
    }
    for (const kind of profile.lifecycle.corrected) {
      if (profile.lifecycle.external.includes(kind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lifecycle", "corrected"],
          message:
            `"${kind}" is listed as external, and the server never writes an external kind, so an overwrite of it cannot be recorded as a correction. ` +
            `When the profile does not set it, corrected defaults to ${DEFAULT_CORRECTED.join(" and ")}.`,
        });
      }
    }

    for (const token of unknownIdPlaceholders(profile.assessmentId.template)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assessmentId", "template"], message: `"{${token}}" is not an assessment id placeholder; the placeholders are {prefix}, {yyyy}, {mm}, {item} and {item:N}` });
    }

    // The rendered id names a folder, is part of file names, and keys the journal's partition, so
    // it must hold nothing any of the three refuses. Checked here because the alternative is an
    // open that creates the list item and then cannot create its folder or journal its writes.
    const idIssue = (path: string, text: string, what: string): void => {
      const refused = firstRefusedNameCharacter(text) ?? REFUSED_IN_A_KEY.exec(text)?.[0];
      if (refused !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assessmentId", path], message: `${what} cannot contain "${refused}": the id names a folder and keys the journal, and one of them refuses that character` });
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

    // One list under two roles would mix vendors, assessments, findings and journal entries in one set of items.
    const listRoles = (["vendors", "assessments", "findings", "journal"] as const).filter((role) => profile.lists[role] !== undefined);
    listRoles.forEach((role, index) => {
      const name = profile.lists[role]!.name.toLowerCase();
      const earlier = listRoles.slice(0, index).find((other) => profile.lists[other]!.name.toLowerCase() === name);
      if (earlier !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lists", role, "name"], message: `this is the same list as lists.${earlier}, and each list needs its own` });
      }
    });

    const labels = Object.values(profile.lifecycle.status);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lifecycle", "status"], message: "the three status labels must differ, or a transition could not be told from the state it leaves" });
    }
  });

export type AssessmentProfile = z.infer<typeof AssessmentProfileSchema>;
