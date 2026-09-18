import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { QUERY_OUTPUT_SCHEMA } from "../query/output.js";
import { QUERY_INPUT_SCHEMA, runQueryRepository } from "../query/run.js";

export const queryRepository: ToolDefinition = {
  name: "query_repository",
  kind: "read",
  title: "Query the repository index",
  description: [
    "Answer operational questions from the stored repository index: empty folders, files whose names do not meet the standard, and recently modified reports.",
    "Costs no new requests against SharePoint when the index is fresh, so prefer it over inventory_tree for repeated questions. Results are as current as the last inventory, which the response reports.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object(QUERY_INPUT_SCHEMA),
  outputSchema: QUERY_OUTPUT_SCHEMA,
  handler: runQueryRepository,
};
