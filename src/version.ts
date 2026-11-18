import { readFileSync } from "node:fs";

/**
 * The version in package.json, read rather than written down a second time.
 * A peer server's users had to ask which version they were running because it
 * was a constant that had stopped matching the package, and this server's own
 * constant would have gone the same way at the first release.
 *
 * The path is the same from `src` under tsx and from `dist` once compiled:
 * both sit one directory below package.json. When the file cannot be read or
 * holds no version, the answer is "unknown". This function cannot observe the
 * version in that case, and a number it did not read would be an assertion.
 */
export function readPackageVersion(location: URL = new URL("../package.json", import.meta.url)): string {
  try {
    const parsed = JSON.parse(readFileSync(location, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Read once, when the process starts. */
export const SERVER_VERSION = readPackageVersion();
