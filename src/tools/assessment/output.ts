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
  present: z.boolean().describe("True when a file is at the canonical path, for example false before the dossier is saved."),
  eTag: z.string().optional().describe('The file\'s ETag as read, for example "\\"{GUID},3\\"". Absent when no file is present.'),
  size: z.number().int().optional().describe("The file's size in bytes as read, for example 16. Absent when no file is present."),
} satisfies z.ZodRawShape;

export const JOURNAL_SUMMARY_SHAPE = {
  entries: z.number().int().describe("Journal entries recorded under this assessment id, for example 7."),
  lastAt: z.string().optional().describe('When the latest entry was recorded, for example "2026-11-07T20:39:33.000Z". Absent when there are none.'),
  byOperation: z.record(z.number().int()).describe('Entry counts by operation, for example {"folder_created": 6, "list_item_updated": 1}.'),
} satisfies z.ZodRawShape;

/**
 * Present only on an isError result from refusalResult. The SDK skips output
 * validation on an error result, so these fields are documentation of that
 * shape rather than something a success ever carries; all are optional for
 * that reason. The refused assessment's id rides on the summary's own
 * assessmentId field.
 */
export const REFUSAL_SHAPE = {
  refused: z.boolean().optional().describe("Present and true only on a refusal, for example true when the prior stage is not verified."),
  tool: z.string().optional().describe('The refusing tool, present only on a refusal, for example "save_artifact".'),
  stage: z.string().optional().describe('The stage refused, present only on a refusal, for example "DOSSIER".'),
  expected: z.string().optional().describe('What the precondition required, present only on a refusal, for example "the workspace root folder present".'),
  observed: z.string().optional().describe('What was read instead, present only on a refusal, for example "the folder was not found".'),
  evidence: z
    .array(z.object({ source: z.enum(["list", "drive"]), target: z.string(), found: z.string() }))
    .optional()
    .describe('What was read and where, present only on a refusal, for example [{"source": "drive", "target": "Assessments/Acme Corp/ASM-2026-00002", "found": "not found"}].'),
} satisfies z.ZodRawShape;
