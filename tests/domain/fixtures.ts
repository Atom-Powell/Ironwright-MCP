export const validProfile = {
  profileId: "example",
  identity: {
    siteUrl: "https://contoso.sharepoint.com/sites/Example",
    library: "Compliance Reports",
    workbookPath: "/Trackers/Operational Tracking Workbook.xlsx",
  },
  taxonomy: { segments: ["{year}", "{client}", "{month:02}-{monthName}"] },
  naming: {
    template: "{year}-{month:02}_{client}_{deliverable}.xlsx",
    recognizers: [
      {
        id: "legacy-spaced",
        pattern: "^(?<client>[A-Z0-9]+) Monthly - (?<monthName>[A-Za-z]{3,}) (?<year>\\d{4})\\.xlsx$",
        deliverable: "MonthlyTraining",
        verdict: "misnamed",
      },
    ],
  },
  deliverables: [
    {
      id: "MonthlyTraining",
      token: "MonthlyTraining",
      cadence: "monthly",
      appliesTo: { workbookField: "monthlyTraining", truthy: true },
    },
  ],
  workbookMapping: {
    source: { kind: "table", name: "ClientRoster" },
    headerRow: 1,
    columns: { client: "Client", monthlyTraining: "Monthly Training" },
  },
  window: { mode: "rolling", months: 12, respectEffectiveFrom: false },
};
