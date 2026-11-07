import { AssessmentProfileSchema } from "../../domain/profile/assessment.js";
import { getAssessment } from "../../tools/definitions/get-assessment.js";
import { openAssessment } from "../../tools/definitions/open-assessment.js";
import type { DomainModule } from "../types.js";

/** The governed assessment workspace. The remaining tools join in Tasks 6 and 7 of the 9c plan. */
export const assessmentModule: DomainModule = {
  kind: "assessment",
  profileSchema: AssessmentProfileSchema,
  tools: [openAssessment, getAssessment],
};
