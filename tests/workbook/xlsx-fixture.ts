import { zipSync, strToU8 } from "fflate";

/**
 * Hand written OOXML parts assembled into a zip with fflate's zipSync, not
 * generated through scripts/seed/blank-workbook.ts. That writer and this
 * reader agreeing would prove only that they agree with each other, not that
 * either agrees with what Excel actually produces.
 */

const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_TYPE_WORKSHEET = `${NS_R}/worksheet`;
const REL_TYPE_TABLE = `${NS_R}/table`;

export interface SheetSpec {
  name: string;
  rowsXml: string;
  /**
   * Overrides the relationship id the <sheet> entry carries. Defaults to a
   * value derived from array position, which is exactly the coincidence a
   * regression could lean on; a caller proving the r:id indirection is what
   * actually resolves a sheet must set this to something that does not match
   * the sheet's own position.
   */
  rId?: string;
  /**
   * Overrides the worksheet part's file number (xl/worksheets/sheet<N>.xml).
   * Defaults to the sheet's array position, same caveat as rId above.
   */
  partNumber?: number;
  /**
   * The value written as <dimension ref="...">, sibling to <sheetData>
   * rather than derived from rowsXml. Omitted entirely means the worksheet
   * part carries no <dimension> element at all, which is also a real shape
   * a workbook can have, not just "not set".
   */
  dimension?: string;
  /**
   * Writes this sheet's <sheet> entry with no name attribute. A real
   * workbook does not have this, but a truncated or hand-edited one can, and
   * a reader that drops such an entry silently reports a workbook with fewer
   * sheets than it declares.
   */
  omitName?: boolean;
  /**
   * Writes this sheet's <sheet> entry with no r:id attribute, so the entry
   * states no link at all to a worksheet part.
   */
  omitRelationshipId?: boolean;
  /**
   * Keeps the <sheet> entry's r:id but leaves this one sheet's
   * <Relationship> out of xl/_rels/workbook.xml.rels, so the id dangles.
   * Distinct from omitParts, which can only drop the whole rels part and
   * with it every sheet's link at once: a dangling single id is the shape
   * resolveWorksheet in xlsx.ts raises its own WorkbookFileError for, and
   * nothing could build it before this flag existed.
   */
  omitRelationship?: boolean;
  /**
   * Writes the worksheet part, and any table rels that hang off it, but no
   * <sheet> entry and no workbook relationship for it at all. That is a
   * worksheet part the workbook's own sheet list never declares, which is
   * the only way to build a table whose owning part is genuinely undeclared
   * rather than merely unresolvable.
   */
  omitSheetListEntry?: boolean;
}

export interface TableSpec {
  name: string;
  ref: string;
  /** Index into the sheets array whose worksheet owns this table. */
  sheetIndex: number;
  /**
   * The exact value written as <table headerRowCount="...">. Omitted
   * entirely means the table root carries no headerRowCount attribute at
   * all, which OOXML defines as "1", a header row present.
   */
  headerRowCount?: string;
  /**
   * Writes this table's root with a ref but no name attribute. A real
   * workbook does not have this, but a truncated or hand-edited one can;
   * findTables in xlsx.ts requires both name and ref to report a table part
   * at all, so this is the one shape that reaches neither the resolved
   * table list nor the unresolved list. See docs/OPEN-ITEMS.md.
   */
  omitName?: boolean;
}

export interface BuildWorkbookOptions {
  /**
   * The exact attribute value to emit as <calcPr fullCalcOnLoad="...">, such
   * as "1", "true", "0" or "false". Omitted entirely means the calcPr tag
   * carries no fullCalcOnLoad attribute at all, which is also "not set".
   */
  fullCalcOnLoad?: string;
  sheets?: SheetSpec[];
  sharedStrings?: string[];
  tables?: TableSpec[];
  /** Shorthand for a single sheet named Sheet1 holding this row XML. */
  sheet?: string;
  /** Omit named parts entirely, to exercise the missing-part failure. */
  omitParts?: string[];
}

function relationshipId(sheet: SheetSpec, index: number): string {
  return sheet.rId ?? `rIdSheet${String(index)}`;
}

function partNumber(sheet: SheetSpec, index: number): number {
  return sheet.partNumber ?? index;
}

export function buildWorkbook(options: BuildWorkbookOptions): Uint8Array {
  const sheets = options.sheets ?? [{ name: "Sheet1", rowsXml: options.sheet ?? "" }];
  const omit = new Set(options.omitParts ?? []);
  const parts: Record<string, Uint8Array> = {};

  const sheetEntries = sheets
    .map((sheet, index) => {
      if (sheet.omitSheetListEntry === true) return "";
      const name = sheet.omitName === true ? "" : ` name="${sheet.name}"`;
      const rId = sheet.omitRelationshipId === true ? "" : ` r:id="${relationshipId(sheet, index)}"`;
      return `<sheet${name} sheetId="${String(index + 1)}"${rId}/>`;
    })
    .join("");
  const calcPr =
    options.fullCalcOnLoad !== undefined
      ? `<calcPr calcId="0" fullCalcOnLoad="${options.fullCalcOnLoad}"/>`
      : '<calcPr calcId="0"/>';
  if (!omit.has("xl/workbook.xml")) {
    parts["xl/workbook.xml"] =
      strToU8(`<?xml version="1.0"?><workbook xmlns:r="${NS_R}"><sheets>${sheetEntries}</sheets>${calcPr}</workbook>`);
  }

  const workbookRelEntries = sheets
    .map((sheet, index) =>
      sheet.omitRelationship === true || sheet.omitSheetListEntry === true
        ? ""
        : `<Relationship Id="${relationshipId(sheet, index)}" Type="${REL_TYPE_WORKSHEET}" ` +
          `Target="worksheets/sheet${String(partNumber(sheet, index))}.xml"/>`,
    )
    .join("");
  if (!omit.has("xl/_rels/workbook.xml.rels")) {
    parts["xl/_rels/workbook.xml.rels"] =
      strToU8(`<?xml version="1.0"?><Relationships>${workbookRelEntries}</Relationships>`);
  }

  if (options.sharedStrings) {
    const items = options.sharedStrings.map((text) => `<si><t>${text}</t></si>`).join("");
    parts["xl/sharedStrings.xml"] = strToU8(`<?xml version="1.0"?><sst>${items}</sst>`);
  }

  sheets.forEach((sheet, index) => {
    const partName = `xl/worksheets/sheet${String(partNumber(sheet, index))}.xml`;
    if (omit.has(partName)) return;
    const dimension = sheet.dimension !== undefined ? `<dimension ref="${sheet.dimension}"/>` : "";
    parts[partName] = strToU8(
      `<?xml version="1.0"?><worksheet>${dimension}<sheetData>${sheet.rowsXml}</sheetData></worksheet>`,
    );
  });

  (options.tables ?? []).forEach((table, tableIndex) => {
    const owningSheet = sheets[table.sheetIndex];
    if (owningSheet === undefined) {
      throw new Error(`Fixture error: table "${table.name}" names sheetIndex ${String(table.sheetIndex)}, which is not in sheets.`);
    }
    const owningPartNumber = partNumber(owningSheet, table.sheetIndex);

    const tablePartName = `xl/tables/table${String(tableIndex)}.xml`;
    const headerRowCount = table.headerRowCount !== undefined ? ` headerRowCount="${table.headerRowCount}"` : "";
    const nameAttribute = table.omitName === true ? "" : ` name="${table.name}" displayName="${table.name}"`;
    if (!omit.has(tablePartName)) {
      parts[tablePartName] = strToU8(
        '<?xml version="1.0"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          `id="${String(tableIndex + 1)}"${nameAttribute} ref="${table.ref}"` +
          `${headerRowCount}></table>`,
      );
    }

    // Honoring omit here too, consistent with every other part written
    // above: this is the reverse link findOwningWorksheetPart depends on,
    // and a caller proving that a table with no such link cannot be
    // resolved needs to omit exactly this part without also losing the
    // table part itself.
    const relsPartName = `xl/worksheets/_rels/sheet${String(owningPartNumber)}.xml.rels`;
    if (!omit.has(relsPartName)) {
      parts[relsPartName] = strToU8(
        "<?xml version=\"1.0\"?><Relationships>" +
          `<Relationship Id="rIdTable${String(tableIndex)}" Type="${REL_TYPE_TABLE}" ` +
          `Target="../tables/table${String(tableIndex)}.xml"/></Relationships>`,
      );
    }
  });

  return zipSync(parts);
}
