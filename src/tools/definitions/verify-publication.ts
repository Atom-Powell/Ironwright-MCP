import { z } from "zod";
import { SAFETY_SENTENCES } from "../kinds.js";
import type { ToolDefinition } from "../types.js";
import { VERIFY_INPUT_SCHEMA, VERIFY_OUTPUT_SCHEMA, runVerifyPublication } from "../assessment/verify-publication.js";

export const verifyPublication: ToolDefinition = {
  name: "verify_publication",
  kind: "read",
  title: "Verify a publication",
  description: [
    "Read the canonical path the profile renders for an artifact produced outside this server, by default the publication, and report what is there: whether a file is present, its name, size, ETag, last modified time and URL. The profile lists which artifact kinds are external; when it lists one, as the default does, kind may be omitted.",
    "An absent file, or a file at the path whose name differs from the expected name, is reported as present false, not as an error. An external artifact is written by a person or the consumer's publisher, never by this server.",
    SAFETY_SENTENCES.read,
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object(VERIFY_INPUT_SCHEMA),
  outputSchema: VERIFY_OUTPUT_SCHEMA,
  handler: runVerifyPublication,
};
