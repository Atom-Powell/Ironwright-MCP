import { unzipSync, strFromU8 } from "fflate";

/**
 * Refused by inspection rather than discovered by exhausting memory. A zip
 * states each entry's uncompressed size in its own directory, so a hostile
 * archive can be turned away before a single byte is inflated. This is the
 * difference between a rejection and an out-of-memory kill of the server.
 */
export const MAX_INFLATED_BYTES = 200 * 1024 * 1024;

export function readZipParts(
  bytes: Uint8Array,
  wanted: (name: string) => boolean,
  options?: { maxInflatedBytes?: number },
): Map<string, string> {
  const cap = options?.maxInflatedBytes ?? MAX_INFLATED_BYTES;
  let declared = 0;

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        declared += file.originalSize;
        if (declared > cap) {
          throw new Error(
            `The workbook declares ${String(declared)} bytes of uncompressed content, past the ` +
              `${String(cap)} byte limit this server will inflate.`,
          );
        }
        return wanted(file.name);
      },
    });
  } catch (error) {
    // fflate throws its own error for malformed input. The filter's own throw
    // is re-raised unchanged, because it already says what an operator needs
    // and rewording it here would replace a true statement with a guess about
    // which of the two causes applied.
    if (error instanceof Error && error.message.includes("uncompressed content")) throw error;
    throw new Error(
      "The downloaded file is not a zip archive, so it is not an xlsx workbook. The profile's workbookPath " +
        "may name a file that is not a workbook, or the download was truncated.",
      { cause: error },
    );
  }

  const parts = new Map<string, string>();
  for (const [name, content] of Object.entries(files)) parts.set(name, strFromU8(content));
  return parts;
}
