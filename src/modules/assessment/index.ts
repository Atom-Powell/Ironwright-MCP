import { AssessmentProfileSchema } from "../../domain/profile/assessment.js";
import { getAssessment } from "../../tools/definitions/get-assessment.js";
import { openAssessment } from "../../tools/definitions/open-assessment.js";
import { readAssessmentArtifact } from "../../tools/definitions/read-assessment-artifact.js";
import { recordFindings } from "../../tools/definitions/record-findings.js";
import { saveAssessmentArtifact } from "../../tools/definitions/save-assessment-artifact.js";
import { transitionAssessment } from "../../tools/definitions/transition-assessment.js";
import { verifyPublication } from "../../tools/definitions/verify-publication.js";
import type { DomainModule } from "../types.js";

/** The governed assessment workspace: its seven tools, in the order a workflow calls them. */
export const assessmentModule: DomainModule = {
  kind: "assessment",
  profileSchema: AssessmentProfileSchema,
  tools: [openAssessment, saveAssessmentArtifact, readAssessmentArtifact, recordFindings, transitionAssessment, verifyPublication, getAssessment],
};
