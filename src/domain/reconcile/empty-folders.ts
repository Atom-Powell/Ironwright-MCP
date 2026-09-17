import type { RepositorySnapshot } from "./types.js";

/**
 * Every strict ancestor folder of a library-relative path, from the immediate
 * parent upward. A path with no separator has no ancestors.
 */
function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  let cursor = path.lastIndexOf("/");
  while (cursor > 0) {
    ancestors.push(path.slice(0, cursor));
    cursor = path.lastIndexOf("/", cursor - 1);
  }
  return ancestors;
}

/**
 * The folders with nothing beneath them: no file, and no deeper folder.
 *
 * Occupancy is decided by collecting the ancestors of everything the scan
 * found rather than by asking, per folder, whether some path begins with it.
 * A `startsWith` test on the folder path is the trap here: "2026/CLIENTAB" and
 * every file under it begin with the characters of "2026/CLIENTA", so an
 * unrelated sibling with a longer name would silently mark CLIENTA occupied
 * and an empty folder would never be reported. Splitting on the separator
 * makes the comparison whole-segment by construction, so the trap cannot be
 * reintroduced by an edit here.
 *
 * The result is deduplicated and sorted by path, because two scan entries for
 * one folder must not become two rows in the report, and the report is
 * compared against a golden file.
 *
 * A file carrying `library` came from the Microsoft Search cross-check and
 * sits in a different document library, not in this profile's own one, so it
 * cannot occupy a folder here: `repository.folderPaths` is the profile's own
 * library's folder listing, and a library-relative path from another library
 * occupying it by coincidence of spelling would mark a genuinely empty client
 * folder in the profile's own library as occupied. Such a file is excluded
 * from this walk for the same reason it is excluded from orphan reporting in
 * match.ts: this cross-check only ever supplies candidates for expected
 * artifacts, never facts about the profile's own library's contents.
 */
export function findEmptyFolders(repository: RepositorySnapshot): string[] {
  const occupied = new Set<string>();

  for (const file of repository.files) {
    if (file.library !== undefined) continue;
    for (const ancestor of ancestorsOf(file.path)) {
      occupied.add(ancestor);
    }
  }

  for (const folderPath of repository.folderPaths) {
    for (const ancestor of ancestorsOf(folderPath)) {
      occupied.add(ancestor);
    }
  }

  return [...new Set(repository.folderPaths)].filter((folderPath) => !occupied.has(folderPath)).sort();
}
