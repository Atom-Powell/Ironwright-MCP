// scripts/assessment-probe/lists.ts
/**
 * The three lists the assessment module treats as the consumer's system of
 * record: vendors, assessments and findings. Column names here are the
 * module's logical field names used directly as internal names, which is the
 * simplest profile a customer could write (an identity column map). A real
 * customer's lists map their own internal names in the profile instead.
 *
 * Created by the seed under the grant issuer's token, never by the server:
 * creating a list is setup, and the server's Sites.Selected grant is for
 * reading and writing items, which is what the probes measure.
 */
export interface ListDefinition {
  displayName: string;
  body: unknown;
}

function text(name: string, multiline = false): unknown {
  return multiline ? { name, text: { allowMultipleLines: true } } : { name, text: {} };
}

export function listDefinitions(prefix: string): ListDefinition[] {
  return [
    {
      displayName: `${prefix} Vendors`,
      body: { displayName: `${prefix} Vendors`, list: { template: "genericList" }, columns: [text("FolderName")] },
    },
    {
      displayName: `${prefix} Assessments`,
      body: {
        displayName: `${prefix} Assessments`,
        list: { template: "genericList" },
        columns: [
          text("AssessmentId"),
          text("VendorFolder"),
          text("Scope"),
          text("Status"),
          text("State"),
          text("Disposition"),
          text("Risk"),
          text("Summary", true),
        ],
      },
    },
    {
      displayName: `${prefix} Findings`,
      body: {
        displayName: `${prefix} Findings`,
        list: { template: "genericList" },
        columns: [text("AssessmentId"), text("FindingKey"), text("Observation", true), text("Risk"), text("Recommendation", true)],
      },
    },
  ];
}
