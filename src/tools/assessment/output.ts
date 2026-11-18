import { z } from "zod";

/**
 * One assessment as the Assessments list holds it. Only the item id is
 * certain: every other field is what the list item carries, absent when the
 * item holds no value, because a fresh assessment has no state, disposition
 * or risk yet and an item an interrupted open left behind has no id. A
 * schema that required them would refuse a result the server read correctly,
 * and filling them in would report a value nobody wrote.
 */
export const ASSESSMENT_SUMMARY_SHAPE = {
  assessmentId: z.string().optional().describe('The rendered assessment id, for example "ASM-2026-00002". Absent on an item whose id was never written.'),
  itemId: z.string().describe('The Assessments list item id, for example "2".'),
  vendor: z.string().optional().describe('The vendor\'s display name, the item\'s Title, for example "Acme Corp".'),
  vendorFolder: z.string().optional().describe('The vendor\'s folder name, for example "Acme Corp".'),
  scope: z.string().optional().describe('What the assessment covers, for example "Security".'),
  status: z.string().optional().describe('The status label, for example "In Progress".'),
  state: z.string().optional().describe('The last stage the assessment reached, for example "ID". Absent when the item holds none.'),
  disposition: z.string().optional().describe('The recorded disposition, for example "Approved with conditions". Absent until one is recorded.'),
  risk: z.string().optional().describe('The recorded overall risk, for example "Medium". Absent until one is recorded.'),
} satisfies z.ZodRawShape;

export const ARTIFACT_PRESENCE_SHAPE = {
  kind: z.string().describe('The profile\'s artifact kind, for example "dossier".'),
  path: z.string().describe('Library-relative canonical path, for example "Assessments/Acme Corp/ASM-2026-00002/Research/Acme Corp_Research_Dossier.md".'),
  present: z.boolean().describe("True when a file named exactly as the profile's template renders is at the canonical path, for example false before the dossier is saved, or when the path holds a folder or a file whose name differs by case."),
  eTag: z.string().optional().describe('The file\'s ETag as read, for example "\\"{GUID},3\\"". Absent when no file is present.'),
  size: z.number().int().optional().describe("The file's size in bytes as read, for example 16. Absent when no file is present."),
  occupant: z
    .object({
      name: z.string().describe('The name of what the lookup answered, for example "acme corp_research_dossier.md".'),
      isFolder: z.boolean().describe("True when it is a folder, for example false for a file under another name."),
    })
    .optional()
    .describe('What the path lookup answered when it was not the artifact: a folder, or a file whose name differs by case, for example {"name": "acme corp_research_dossier.md", "isFolder": false}. Absent when the path is empty or holds the artifact.'),
} satisfies z.ZodRawShape;

export const JOURNAL_SUMMARY_SHAPE = {
  entries: z.number().int().describe("Journal entries recorded under this assessment id, for example 7."),
  lastAt: z.string().optional().describe('When the latest entry was recorded, for example "2026-11-07T20:39:33.000Z". Absent when there are none.'),
  byOperation: z.record(z.number().int()).describe('Entry counts by operation, for example {"folder_created": 6, "list_item_updated": 1}.'),
} satisfies z.ZodRawShape;

/** One lifecycle tool's precondition as get_assessment reports it; see lifecycleReadiness in the domain layer. */
export const READINESS_SHAPE = {
  tool: z.string().describe('The lifecycle tool, for example "record_findings".'),
  target: z.string().optional().describe('The status a transition would move to, for example "completed". Absent for the other tools.'),
  ready: z.boolean().describe("True when the tool's precondition held on the state read, for example false for a transition to completed before the publication exists."),
  expected: z.string().optional().describe('What the precondition needs, for example "the publication present at its canonical path". Absent when ready.'),
  observed: z.string().optional().describe('What was read instead, for example "not present". Absent when ready.'),
  evidence: z
    .array(
      z.object({
        source: z.enum(["list", "drive"]).describe('Where it was read, for example "drive".'),
        target: z.string().describe('What was read, for example "Assessments/Acme Corp/ASM-2026-00002/Published/Acme Corp_ASM-2026-00002_Risk_Assessment.docx".'),
        found: z.string().describe('What it held, for example "not found".'),
      }),
    )
    .optional()
    .describe('What was read to decide, for example [{"source": "drive", "found": "not found"}]. Absent when ready.'),
} satisfies z.ZodRawShape;

export const FINDING_READ_SHAPE = {
  key: z.string().optional().describe('The finding key, for example "F-1". Absent on a row whose key column is empty.'),
  itemId: z.string().describe('The Findings list item id, for example "11".'),
  risk: z.string().optional().describe('The risk label the row holds, for example "High".'),
  observation: z.string().optional().describe('What was found, for example "SOC 2 Type II report covers only the hosting subsidiary."'),
  recommendation: z.string().optional().describe('What to do, for example "Request the parent company report."'),
} satisfies z.ZodRawShape;

export const JOURNAL_ENTRY_SHAPE = {
  at: z.string().describe('When the entry was recorded, for example "2026-11-07T20:39:33.000Z".'),
  correlationId: z.string().describe('The tool call that made the write, for example "6f1c...".'),
  stage: z.string().describe('The stage the write belonged to, for example "DOSSIER".'),
  operation: z.string().describe('What was written, for example "file_created".'),
  target: z.string().describe('The list and item id, or the library path, for example "Assessments/2".'),
  etagBefore: z.string().optional().describe('The ETag before the write, for example "\\"{GUID},1\\"". Absent on a create.'),
  etagAfter: z.string().optional().describe('The ETag after the write, for example "\\"{GUID},2\\"". Absent when Graph returned none.'),
  contentHash: z.string().optional().describe('sha256 of the file content written, for example "9f86d0...". Absent on a list write.'),
  versionId: z.string().optional().describe('The file version written, for example "2.0". Absent: no tool records it yet.'),
  priorContentHash: z.string().optional().describe('sha256 of the content an overwrite replaced, for example "34a05d...". Absent on a create.'),
} satisfies z.ZodRawShape;
