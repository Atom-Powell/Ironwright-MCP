import type { CustomRefusal } from "../../domain/custom/resolve.js";
import type { ExecuteCustomPlanOutput, GenerateCustomPlanOutput } from "./output.js";

function perStepText(perStep: readonly number[]): string {
  return perStep.map((count, index) => `step ${String(index + 1)}: ${String(count)}`).join(", ");
}

function stepsText(steps: readonly number[]): string {
  return `${steps.length === 1 ? "step" : "steps"} ${steps.map(String).join(", ")}`;
}

function folderName(folder: string): string {
  return folder === "" ? "the library root" : `"${folder}"`;
}

/**
 * Each refusal names what the resolver saw and nothing it did not. Every one
 * says no plan was saved, because each is returned before `savePlan`; the two
 * that a caller could mistake for a partial run, too many files and an unknown
 * folder, also say no ETag was fetched, because each is returned before the
 * fetch loop too.
 */
export function refusalText(refusal: CustomRefusal): string {
  switch (refusal.kind) {
    case "invalid_step": {
      const subject = refusal.step === 0 ? "This request" : `Step ${String(refusal.step)}`;
      return `${subject} is not valid: ${refusal.detail}. No plan was saved.`;
    }
    case "unknown_folder": {
      const field = refusal.field === "folder" ? "selector.folder" : "moveTo";
      const children =
        refusal.children.length === 0
          ? "It has no subfolders."
          : `Its subfolders, at most 10 listed: ${refusal.children.map((child) => `"${child}"`).join(", ")}.`;
      return (
        `Step ${String(refusal.step)}'s ${field} names "${refusal.requested}", which is not a folder in this ` +
        `library, and this tool creates no folders. The nearest existing folder is ${folderName(refusal.nearestExisting)}. ` +
        `${children} No ETag was fetched. No plan was saved.`
      );
    }
    case "ambiguous_set_name":
      return (
        `Step ${String(refusal.step)} uses setName, which gives every file it selects the same name, and its ` +
        `selector matched ${String(refusal.matched)} files. Narrow the selector to exactly one file. No plan was saved.`
      );
    case "too_many_files":
      return (
        `These steps select ${String(refusal.total)} files, more than the ${String(refusal.limit)} one custom plan ` +
        `may hold. Files matched per step: ${perStepText(refusal.perStep)}. Split the work into smaller plans. ` +
        "No ETag was fetched. No plan was saved."
      );
    case "nothing_matched":
      return `No step selected any file. Files matched per step: ${perStepText(refusal.perStep)}. No plan was saved.`;
  }
}

/** Every line states something the output carries, for the reason rename/text.ts gives. */
export function generateCustomPlanText(output: GenerateCustomPlanOutput): string[] {
  const lines = [
    `Plan ${output.planId} for profile "${output.profileId}", library "${output.library}".`,
    `${String(output.itemCount)} ${output.itemCount === 1 ? "item" : "items"} planned, ${String(output.excludedCount)} excluded.`,
    `Files matched per step: ${perStepText(output.perStep)}.`,
    `Based on a repository scan taken at ${output.scannedAt}.`,
  ];
  for (const item of output.items) lines.push(`  ${item.path} -> ${item.targetPath} (step ${String(item.step)})`);
  if (output.itemsOmitted > 0) lines.push(`  ...and ${String(output.itemsOmitted)} more, all of them in the stored plan.`);
  for (const item of output.excluded) {
    lines.push(`  excluded: ${item.path} (${item.reason}, ${stepsText(item.steps)})`);
  }
  if (output.excludedOmitted > 0) {
    lines.push(`  ...and ${String(output.excludedOmitted)} more exclusions, all of them in the stored plan.`);
  }
  lines.push(
    `Graph requests: ${String(output.scanGraphRequestsByThisCall)} for the scan. ` +
      `${String(output.etagLookupsIssued)} etag lookups issued, not counted as Graph requests since a retried ` +
      "lookup can spend more than one.",
  );
  lines.push("Review this plan, then apply it with execute_custom_plan. It runs as a dry run unless confirm is true.");
  return lines;
}

/**
 * Says what happened and nothing more, for the reason executeMovePlanText
 * gives: a clean dry-run preview is not a guarantee, since it contacted Graph
 * not at all and so never checked whether any file has changed since the
 * plan was generated.
 */
export function executeCustomPlanText(output: ExecuteCustomPlanOutput): string[] {
  const lines = output.dryRun
    ? [
        `Dry run of plan ${output.planId} against drive ${output.driveId}. Nothing was changed.`,
        `${String(output.counts.wouldApply)} ${output.counts.wouldApply === 1 ? "item" : "items"} would be applied.`,
        "This preview contacted Graph not at all, so it did not check whether any file has changed since the plan " +
          "was generated. Those refusals can only appear in a confirmed run.",
      ]
    : [
        `Applied plan ${output.planId} against drive ${output.driveId}.`,
        `${String(output.counts.applied)} applied, ${String(output.counts.preconditionRefused)} refused because ` +
          `the item there is not the one the plan recorded, ${String(output.counts.targetNameTaken)} refused ` +
          `because another file already holds the target name, ${String(output.counts.notFound)} no longer at ` +
          `the planned path, ${String(output.counts.failed)} failed.`,
      ];

  // Stated before the item listing rather than beside the reversal line at the
  // end, for the reason executeMovePlanText gives: it changes what every line
  // below it means, since these writes undo another plan's rather than apply
  // new ones.
  if (output.reverses !== undefined) {
    lines.push(`This plan reverses plan ${output.reverses}.`);
  }

  for (const result of output.results) {
    lines.push(`  ${result.path} -> ${result.targetPath} (${result.outcome})`);
  }
  if (output.resultsOmitted > 0) {
    lines.push(`  ...and ${String(output.resultsOmitted)} more, all of them counted above.`);
  }

  for (const item of output.excluded) {
    lines.push(`  excluded at plan time: ${item.path} (${item.reason}, ${stepsText(item.steps)})`);
  }
  if (output.excludedOmitted > 0) {
    lines.push(`  ...and ${String(output.excludedOmitted)} more exclusions, all of them counted above.`);
  }

  if (output.reversalPlanId !== undefined) {
    lines.push(`Reversal plan ${output.reversalPlanId}. Apply it with this same tool to roll this run back.`);
  }
  if (output.reversalEntriesNotRefreshed > 0) {
    lines.push(
      `${String(output.reversalEntriesNotRefreshed)} reversal ${output.reversalEntriesNotRefreshed === 1 ? "entry" : "entries"} ` +
        "could not be given the file's new ETag, so replaying the reversal will refuse those items rather than " +
        "undo them. Generate a fresh plan for those files.",
    );
  }
  lines.push(`Graph operations issued: ${String(output.graphOperationsIssued)}.`);

  return lines;
}
