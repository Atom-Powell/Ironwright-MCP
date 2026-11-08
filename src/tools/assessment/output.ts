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
