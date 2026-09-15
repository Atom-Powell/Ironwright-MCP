import type { SeedProfileInput } from "../../../scripts/seed-library.js";

export function exampleSeedProfile(): SeedProfileInput {
  // Mirrors examples/profiles/example.json's taxonomy, naming, and
  // deliverables exactly, since the spec that drove this script names that
  // file as the token vocabulary this seeder has to support.
  return {
    identity: {
      siteUrl: "https://contoso.sharepoint.com/sites/Example",
      library: "Compliance Reports",
      workbookPath: "/Trackers/Operational Tracking Workbook.xlsx",
    },
    taxonomy: { segments: ["{year}", "{client}", "{month:02}-{monthName}"] },
    naming: { template: "{year}-{month:02}_{client}_{deliverable}.xlsx" },
    deliverables: [
      { token: "MonthlyTraining", cadence: "monthly" },
      { token: "QuarterlyPhishing", cadence: "quarterly" },
    ],
  };
}
