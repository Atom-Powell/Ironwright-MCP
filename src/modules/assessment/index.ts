import { AssessmentProfileSchema } from "../../domain/profile/assessment.js";
import type { DomainModule } from "../types.js";

/** The governed assessment workspace. Tools join in Tasks 5 to 7 of the 9c plan. */
export const assessmentModule: DomainModule = {
  kind: "assessment",
  profileSchema: AssessmentProfileSchema,
  tools: [],
};
