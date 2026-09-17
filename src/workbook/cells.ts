/**
 * A cell whose value cannot be read with confidence. A symbol rather than null
 * or undefined so a caller cannot mistake it for an empty cell: substituting a
 * value for an unevaluable one produces a wrong compliance finding and raises
 * nothing, which this project holds to be its most expensive failure.
 */
export const UNEVALUABLE = Symbol("unevaluable");

export type CellValue = string | number | boolean | null | typeof UNEVALUABLE;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * The five predefined entities and numeric references, and nothing else. A
 * general parser resolves whatever entity a document declares, which is how
 * reading OOXML becomes an XXE vector; this server holds SharePoint
 * credentials, so an unknown entity is refused rather than resolved.
 */
export function unescapeXmlText(text: string): string {
  return text.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g, (match, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    const named = NAMED_ENTITIES[body];
    if (named !== undefined) return named;
    throw new Error(
      `The workbook XML references the entity "${match}", which is not one of the five XML predefines. ` +
        "Entities are not resolved here, so a document that declares its own is refused rather than expanded.",
    );
  });
}

/** Every <t> inside one <si>, concatenated, which is how a rich text run reads as one string. */
export function parseSharedStrings(xml: string): string[] {
  const items: string[] = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = "";
    for (const t of (si[1] ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXmlText(t[1] ?? "");
    items.push(text);
  }
  return items;
}

/**
 * Reads one attribute's value out of a tag's own text, such as
 * `t="s"` out of `<c r="A1" t="s">`. Shared with xlsx.ts, which reads
 * attributes off a different set of tags (`<sheet>`, `<Relationship>`,
 * `<table>`, `<calcPr>`) with the same shape, so one implementation serves
 * both rather than two copies risking a silent divergence.
 */
export function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

export function decodeCell(cellXml: string, sharedStrings: string[]): CellValue {
  // `\b` after `c` keeps this from matching an element such as `<col>`,
  // consistent with the same boundary sheet.ts's own cell-matching pattern
  // already requires.
  const openTag = /^<c\b[^>]*>/.exec(cellXml)?.[0] ?? cellXml;
  const type = attribute(openTag, "t");
  const hasFormula = /<f[\s>/]/.test(cellXml);
  const rawValue = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cellXml)?.[1];

  // An error cell holds a cached value that is not a value. #N/A in a lookup
  // column is ordinary, and substituting an empty string there would report a
  // client as owing nothing, which reads as compliance.
  if (type === "e") return UNEVALUABLE;

  if (type === "inlineStr") {
    const inline = /<is>([\s\S]*?)<\/is>/.exec(cellXml)?.[1];
    if (inline === undefined) return UNEVALUABLE;
    let text = "";
    for (const t of inline.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXmlText(t[1] ?? "");
    return text;
  }

  if (rawValue === undefined) {
    // A formula with no cached value means Excel never wrote a result, so
    // there is nothing to read. An empty cell with no formula is just empty.
    return hasFormula ? UNEVALUABLE : null;
  }

  // A <v> tag can be present and still carry no text, and that is not the same
  // as a <v> that was never written. Number("") is 0 in JavaScript, so passing
  // an empty value straight to a numeric or index parse would silently report
  // a zero, a shared string at index 0, or a false boolean that nothing in the
  // file actually asserts, which is exactly the substitution this module
  // exists to refuse. t="str" is exempted: an explicit empty string is that
  // type's ordinary way of writing a text result of "".
  if (rawValue === "" && type !== "str") return UNEVALUABLE;

  if (type === "s") {
    const text = sharedStrings[Number(rawValue)];
    // An index naming no entry is a malformed file rather than an empty cell,
    // and guessing at empty would put a blank client name into the report.
    return text ?? UNEVALUABLE;
  }

  if (type === "b") return rawValue === "1";
  if (type === "str") return unescapeXmlText(rawValue);

  const numeric = Number(rawValue);
  return Number.isNaN(numeric) ? unescapeXmlText(rawValue) : numeric;
}
