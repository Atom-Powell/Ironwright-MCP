import { AssessmentProfileSchema } from "../../domain/profile/assessment.js";
import { getAssessment } from "../../tools/definitions/get-assessment.js";
import { openAssessment } from "../../tools/definitions/open-assessment.js";
import { readAssessmentArtifact } from "../../tools/definitions/read-assessment-artifact.js";
import { saveAssessmentArtifact } from "../../tools/definitions/save-assessment-artifact.js";
import { verifyPublication } from "../../tools/definitions/verify-publication.js";
import type { DomainModule } from "../types.js";

/** The governed assessment workspace. The remaining tools join in Task 7 of the 9c plan. */
export const assessmentModule: DomainModule = {
  kind: "assessment",
  profileSchema: AssessmentProfileSchema,
  tools: [openAssessment, getAssessment, saveAssessmentArtifact, readAssessmentArtifact, verifyPublication],
};
