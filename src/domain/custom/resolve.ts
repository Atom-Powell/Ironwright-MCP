import { joinPath, parentOf } from "../plans/collisions.js";
import { invalidNameReason, splitName } from "./names.js";

/**
 * Which files a step acts on. Folders are library-relative and may be written
 * with or without surrounding slashes; "" or "/" is the library root.
 */
export interface CustomSelector {
  folder: string;
  recursive?: boolean;
  nameEquals?: string;
  nameContains?: string;
  extensions?: string[];
  modifiedAfter?: string;
  modifiedBefore?: string;
}

export type CustomRename =
  { setName: string } | { replace: { find: string; with: string } } | { addPrefix: string } | { addSuffix: string };

export interface CustomStep {
  selector: CustomSelector;
  moveTo?: string;
  rename?: CustomRename;
}

export type CustomExclusionReason =
  | "matched_by_multiple_steps"
  | "no_change"
  | "extension_would_change"
  | "invalid_target_name"
  | "target_path_already_occupied"
  | "two_items_share_one_target";

export interface ResolvedItem {
  path: string;
  currentName: string;
  targetName: string;
  targetPath: string;
  step: number;
}

export interface ResolvedExclusion {
  path: string;
  currentName: string;
  targetName: string;
  reason: CustomExclusionReason;
  steps: number[];
}

export type CustomRefusal =
  | { kind: "invalid_step"; step: number; detail: string }
  | {
      kind: "unknown_folder";
      step: number;
      field: "folder" | "moveTo";
      requested: string;
      nearestExisting: string;
      children: string[];
    }
  | { kind: "ambiguous_set_name"; step: number; matched: number }
  | { kind: "too_many_files"; perStep: number[]; total: number; limit: number }
  | { kind: "nothing_matched"; perStep: number[] };

export type CustomResolution =
  | {
      ok: true;
      items: ResolvedItem[];
      exclusions: ResolvedExclusion[];
      perStep: number[];
    }
  | { ok: false; refusal: CustomRefusal };

/** Bounds one plan to what an operator can actually review before approving it. */
export const MAX_CUSTOM_PLAN_FILES = 100;
export const MAX_CUSTOM_PLAN_STEPS = 20;

/** How many sibling folders an unknown-folder refusal lists, so it stays readable. */
const MAX_CHILDREN_LISTED = 10;

const RENAME_FORMS = ["setName", "replace", "addPrefix", "addSuffix"] as const;

interface SnapshotFile {
  path: string;
  name: string;
  modified: string;
  library?: string;
}

interface Snapshot {
  files: readonly SnapshotFile[];
  folderPaths: readonly string[];
}

/** Plain code-unit order, so the same input always sorts the same way regardless of locale. */
function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function normalizeFolder(raw: string): string {
  return raw.replace(/^\/+/, "").replace(/\/+$/, "");
}

type RenameForm =
  | { form: "setName"; value: string }
  | { form: "replace"; value: { find: string; with: string } }
  | { form: "addPrefix"; value: string }
  | { form: "addSuffix"; value: string };

/**
 * The single definition of which rename forms a rename object carries: a key
 * counts only when its value is not undefined. A caller building the object
 * field by field can leave unset keys behind, and testing key presence with
 * `in` would then read a form nobody set, or throw on it.
 */
function presentForms(rename: CustomRename): RenameForm[] {
  const fields = rename as Partial<Record<(typeof RENAME_FORMS)[number], unknown>>;
  return RENAME_FORMS.filter((form) => fields[form] !== undefined).map(
    (form) => ({ form, value: fields[form] }) as RenameForm,
  );
}

/** The one form a validated rename carries; stepProblem has already refused any other count. */
function renameForm(rename: CustomRename | undefined): RenameForm | undefined {
  return rename === undefined ? undefined : presentForms(rename)[0];
}

/**
 * Checks a step's shape before any file is read. The tool schema cannot
 * express "exactly one rename form" without a refinement, so the rule lives
 * here where every caller passes through it.
 */
function stepProblem(step: CustomStep): string | undefined {
  if (step.moveTo === undefined && step.rename === undefined) {
    return "the step has neither moveTo nor rename, so it would change nothing";
  }
  if (step.rename === undefined) return undefined;
  const forms = presentForms(step.rename);
  const [only] = forms;
  if (forms.length !== 1 || only === undefined) {
    return `rename must carry exactly one of setName, replace, addPrefix or addSuffix; it carries ${String(forms.length)}`;
  }
  if (only.form === "replace") return only.value.find === "" ? "replace.find is empty" : undefined;
  return only.value === "" ? `${only.form} is empty` : undefined;
}

type FolderLookup = { found: true; folder: string } | { found: false; nearestExisting: string; children: string[] };

/**
 * Resolves a requested folder to the index's own casing. SharePoint paths are
 * case-insensitive, so an operator's casing is accepted, but the plan carries
 * the index's casing so the path it writes is the one Graph already holds.
 *
 * An unknown folder is refused rather than created, since creating a folder
 * makes its reversal a delete. The refusal names the deepest ancestor that
 * does exist and its children, which is what an operator needs to correct a
 * typo; it does not guess which child was meant.
 */
function lookupFolder(raw: string, casing: ReadonlyMap<string, string>, folderPaths: readonly string[]): FolderLookup {
  const lower = normalizeFolder(raw).toLowerCase();
  const exact = casing.get(lower);
  if (exact !== undefined) return { found: true, folder: exact };

  const segments = lower.split("/");
  let nearestExisting = "";
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    const ancestor = casing.get(segments.slice(0, depth).join("/"));
    if (ancestor !== undefined) {
      nearestExisting = ancestor;
      break;
    }
  }
  const nearestLower = nearestExisting.toLowerCase();
  const children = folderPaths
    .filter((path) => path !== "" && parentOf(path).toLowerCase() === nearestLower)
    .sort()
    .slice(0, MAX_CHILDREN_LISTED);
  return { found: false, nearestExisting, children };
}

function normalizeExtension(extension: string): string {
  const lower = extension.toLowerCase();
  return lower.startsWith(".") ? lower : `.${lower}`;
}

/**
 * The one use of `Date` in this layer, and it never reads the clock:
 * `Date.parse` is a function of its argument alone for the forms Graph and a
 * date-only bound use, which carry an offset or are defined as UTC. The lint
 * rule bans the global because `new Date()` and `Date.now()` read the clock;
 * this line is the reviewed exception, kept in one place so it stays visible.
 */
function parseInstant(value: string): number {
  // eslint-disable-next-line no-restricted-globals -- Date.parse is pure; see the comment above.
  return Date.parse(value);
}

/**
 * The files one step selects. Every comparison ignores case, matching how
 * SharePoint itself treats names. Both date bounds are exclusive, so two
 * adjacent steps split at one instant can never both claim a file modified
 * exactly then; such a file goes unselected rather than into two steps.
 */
function select(selector: CustomSelector, folder: string, files: readonly SnapshotFile[]): SnapshotFile[] {
  const folderLower = folder.toLowerCase();
  const extensions = selector.extensions?.map(normalizeExtension);
  const nameEquals = selector.nameEquals?.toLowerCase();
  const nameContains = selector.nameContains?.toLowerCase();
  const after = selector.modifiedAfter === undefined ? undefined : parseInstant(selector.modifiedAfter);
  const before = selector.modifiedBefore === undefined ? undefined : parseInstant(selector.modifiedBefore);

  return files.filter((file) => {
    const parent = parentOf(file.path).toLowerCase();
    const inFolder =
      parent === folderLower ||
      (selector.recursive === true && (folderLower === "" || parent.startsWith(`${folderLower}/`)));
    if (!inFolder) return false;
    const name = file.name.toLowerCase();
    if (nameEquals !== undefined && name !== nameEquals) return false;
    if (nameContains !== undefined && !name.includes(nameContains)) return false;
    if (extensions !== undefined && !extensions.includes(splitName(name).extension)) return false;
    const modified = parseInstant(file.modified);
    if (after !== undefined && !(modified > after)) return false;
    if (before !== undefined && !(modified < before)) return false;
    return true;
  });
}

/**
 * The rename rules act on the stem so an operator adding a suffix or replacing
 * a word cannot silently change what kind of file it is; `setName` is the one
 * form that names the whole file, and the extension check catches it.
 */
function targetNameFor(name: string, rename: CustomRename | undefined): string {
  const form = renameForm(rename);
  if (form === undefined) return name;
  const { stem, extension } = splitName(name);
  switch (form.form) {
    case "setName":
      return form.value;
    case "replace":
      return stem.split(form.value.find).join(form.value.with) + extension;
    case "addPrefix":
      return form.value + name;
    case "addSuffix":
      return stem + form.value + extension;
  }
}

interface Candidate {
  file: SnapshotFile;
  step: number;
  targetName: string;
  targetPath: string;
}

/**
 * Resolves operator-written steps against the repository index into exact
 * files, plus the files it will not act on and why. Pure: the index is the
 * only view of the library it has, so anything it cannot settle from that
 * index is refused or excluded here, before a plan reaches review.
 *
 * A refusal rejects the whole request, because it means the request itself
 * is malformed or unreviewable. An exclusion drops one file with a reason and
 * leaves the rest of the plan intact, because one bad file should not block
 * an otherwise sound plan.
 *
 * Only files of the scanned library itself are ever selected. A file carrying
 * `library` came from the Microsoft Search cross-check in a different library
 * of the same site, and nothing here writes outside the scanned library.
 */
export function resolveCustomPlan(steps: readonly CustomStep[], snapshot: Snapshot): CustomResolution {
  if (steps.length === 0 || steps.length > MAX_CUSTOM_PLAN_STEPS) {
    return {
      ok: false,
      refusal: {
        kind: "invalid_step",
        step: 0,
        detail: `the plan has ${String(steps.length)} steps; it must have between 1 and ${String(MAX_CUSTOM_PLAN_STEPS)}`,
      },
    };
  }

  for (const [index, step] of steps.entries()) {
    const detail = stepProblem(step);
    if (detail !== undefined)
      return {
        ok: false,
        refusal: { kind: "invalid_step", step: index + 1, detail },
      };
  }

  // The root is always present even though the index never lists it.
  const casing = new Map<string, string>([["", ""]]);
  for (const path of snapshot.folderPaths) casing.set(path.toLowerCase(), path);

  const resolvedFolders: { folder: string; moveTo: string | undefined }[] = [];
  for (const [index, step] of steps.entries()) {
    const folder = lookupFolder(step.selector.folder, casing, snapshot.folderPaths);
    if (!folder.found) {
      return {
        ok: false,
        refusal: {
          kind: "unknown_folder",
          step: index + 1,
          field: "folder",
          requested: step.selector.folder,
          nearestExisting: folder.nearestExisting,
          children: folder.children,
        },
      };
    }
    let moveTo: string | undefined;
    if (step.moveTo !== undefined) {
      const target = lookupFolder(step.moveTo, casing, snapshot.folderPaths);
      if (!target.found) {
        return {
          ok: false,
          refusal: {
            kind: "unknown_folder",
            step: index + 1,
            field: "moveTo",
            requested: step.moveTo,
            nearestExisting: target.nearestExisting,
            children: target.children,
          },
        };
      }
      moveTo = target.folder;
    }
    resolvedFolders.push({ folder: folder.folder, moveTo });
  }

  const localFiles = snapshot.files.filter((file) => file.library === undefined);
  const matches = steps.map((step, index) => select(step.selector, resolvedFolders[index]?.folder ?? "", localFiles));
  const perStep = matches.map((matched) => matched.length);

  // setName gives every match the same name, so more than one match can only
  // collide; refusing names the step, which an exclusion per file would not.
  for (const [index, step] of steps.entries()) {
    const matched = perStep[index] ?? 0;
    if (renameForm(step.rename)?.form === "setName" && matched > 1) {
      return {
        ok: false,
        refusal: { kind: "ambiguous_set_name", step: index + 1, matched },
      };
    }
  }

  const stepsByPath = new Map<string, { file: SnapshotFile; steps: number[] }>();
  for (const [index, matched] of matches.entries()) {
    for (const file of matched) {
      const entry = stepsByPath.get(file.path);
      if (entry === undefined) stepsByPath.set(file.path, { file, steps: [index + 1] });
      else entry.steps.push(index + 1);
    }
  }
  if (stepsByPath.size === 0) return { ok: false, refusal: { kind: "nothing_matched", perStep } };
  if (stepsByPath.size > MAX_CUSTOM_PLAN_FILES) {
    return {
      ok: false,
      refusal: {
        kind: "too_many_files",
        perStep,
        total: stepsByPath.size,
        limit: MAX_CUSTOM_PLAN_FILES,
      },
    };
  }

  const occupied = new Set(localFiles.map((file) => file.path.toLowerCase()));
  const exclusions: ResolvedExclusion[] = [];
  const candidates: Candidate[] = [];
  const exclude = (file: SnapshotFile, targetName: string, reason: CustomExclusionReason, onSteps: number[]) => {
    exclusions.push({
      path: file.path,
      currentName: file.name,
      targetName,
      reason,
      steps: onSteps,
    });
  };

  for (const { file, steps: onSteps } of stepsByPath.values()) {
    // Two steps disagreeing about one file have no order this plan could
    // honor, so the file is left alone rather than given either answer.
    if (onSteps.length > 1) {
      exclude(file, file.name, "matched_by_multiple_steps", onSteps);
      continue;
    }
    const stepNumber = onSteps[0] ?? 0;
    const step = steps[stepNumber - 1];
    const targetFolder = resolvedFolders[stepNumber - 1]?.moveTo ?? parentOf(file.path);
    const targetName = targetNameFor(file.name, step?.rename);
    const targetPath = joinPath(targetFolder, targetName);

    // Exact comparison, so a case-only rename is still a change worth making.
    if (targetPath === file.path) {
      exclude(file, targetName, "no_change", onSteps);
      continue;
    }
    // Exact comparison here too: a case-only extension change is still a
    // change to what the file claims to be.
    if (splitName(targetName).extension !== splitName(file.name).extension) {
      exclude(file, targetName, "extension_would_change", onSteps);
      continue;
    }
    if (invalidNameReason(targetName, targetFolder === "") !== undefined) {
      exclude(file, targetName, "invalid_target_name", onSteps);
      continue;
    }
    // Case-insensitive because SharePoint is. A file this plan would move away
    // still counts as occupying its path, since the plan does not order its
    // items and a chain could not be applied safely in any fixed order.
    const targetLower = targetPath.toLowerCase();
    if (occupied.has(targetLower) && targetLower !== file.path.toLowerCase()) {
      exclude(file, targetName, "target_path_already_occupied", onSteps);
      continue;
    }
    candidates.push({ file, step: stepNumber, targetName, targetPath });
  }

  // Two files bound for one path cannot both land, and choosing one would be a
  // guess, so every member of the group is excluded.
  const byTarget = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = candidate.targetPath.toLowerCase();
    const group = byTarget.get(key);
    if (group === undefined) byTarget.set(key, [candidate]);
    else group.push(candidate);
  }
  const items: ResolvedItem[] = [];
  for (const group of byTarget.values()) {
    if (group.length === 1) {
      const [only] = group;
      if (only !== undefined) {
        items.push({
          path: only.file.path,
          currentName: only.file.name,
          targetName: only.targetName,
          targetPath: only.targetPath,
          step: only.step,
        });
      }
      continue;
    }
    const unionSteps = [...new Set(group.map((candidate) => candidate.step))].sort((a, b) => a - b);
    for (const candidate of group) {
      exclude(candidate.file, candidate.targetName, "two_items_share_one_target", unionSteps);
    }
  }

  return {
    ok: true,
    items: items.sort(byPath),
    exclusions: exclusions.sort(byPath),
    perStep,
  };
}
