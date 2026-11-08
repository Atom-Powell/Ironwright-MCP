import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { VERIFY_INPUT_SCHEMA, VERIFY_OUTPUT_SCHEMA, runVerifyPublication } from "../assessment/verify-publication.js";

export const verifyPublication: ToolDefinition = {
  name: "verify_publication",
  kind: "read",
  title: "Verify a publication",
  description: [
    "Read the canonical path the profile's publication template renders for an assessment and report what is there: whether a file is present, its name, size, ETag, last modified time and URL.",
    "An absent publication, or a file at the path whose name differs from the expected name, is reported as present false, not as an error. The publication itself is written by the consumer's publisher, never by this server.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object(VERIFY_INPUT_SCHEMA),
  outputSchema: VERIFY_OUTPUT_SCHEMA,
  handler: runVerifyPublication,
};
