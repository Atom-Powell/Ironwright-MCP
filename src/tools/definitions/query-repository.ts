import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { STUB_OUTPUT_SCHEMA } from "../stub-output.js";

export const queryRepository: ToolDefinition = {
  name: "query_repository",
  kind: "read",
  title: "Query the repository index",
  description: [
    "Answer operational questions from the stored repository index: empty folders, orphaned files, naming violations, non-compliant clients, and recently modified reports.",
    "Costs no new requests against SharePoint when the index is fresh, so prefer it over inventory_tree for repeated questions. Results are as current as the last inventory, which the response reports.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    profileId: z.string().min(1).describe("Configured profile to query, for example \"example\"."),
    question: z
      .enum(["empty_folders", "orphaned_files", "naming_violations", "non_compliant_clients", "recent_reports"])
      .describe("Which stored question to answer, for example \"empty_folders\"."),
  },
  outputSchema: STUB_OUTPUT_SCHEMA,
};
