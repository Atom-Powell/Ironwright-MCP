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
}

export interface TableSpec {
  name: string;
  ref: string;
  sheetIndex: number;
}

export interface BuildWorkbookOptions {
  fullCalcOnLoad?: boolean;
  sheets?: SheetSpec[];
  sharedStrings?: string[];
  tables?: TableSpec[];
  /** Shorthand for a single sheet named Sheet1 holding this row XML. */
  sheet?: string;
  /** Omit named parts entirely, to exercise the missing-part failure. */
  omitParts?: string[];
}

export function buildWorkbook(options: BuildWorkbookOptions): Uint8Array {
  const sheets = options.sheets ?? [{ name: "Sheet1", rowsXml: options.sheet ?? "" }];
  const omit = new Set(options.omitParts ?? []);
  const parts: Record<string, Uint8Array> = {};

  const sheetEntries = sheets
    .map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${String(index + 1)}" r:id="rIdSheet${String(index)}"/>`)
    .join("");
  const calcPr = options.fullCalcOnLoad ? '<calcPr calcId="0" fullCalcOnLoad="1"/>' : '<calcPr calcId="0"/>';
  if (!omit.has("xl/workbook.xml")) {
    parts["xl/workbook.xml"] =
      strToU8(`<?xml version="1.0"?><workbook xmlns:r="${NS_R}"><sheets>${sheetEntries}</sheets>${calcPr}</workbook>`);
  }

  const workbookRelEntries = sheets
    .map(
      (_sheet, index) =>
        `<Relationship Id="rIdSheet${String(index)}" Type="${REL_TYPE_WORKSHEET}" ` +
        `Target="worksheets/sheet${String(index)}.xml"/>`,
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
    const partName = `xl/worksheets/sheet${String(index)}.xml`;
    if (omit.has(partName)) return;
    parts[partName] = strToU8(`<?xml version="1.0"?><worksheet><sheetData>${sheet.rowsXml}</sheetData></worksheet>`);
  });

  (options.tables ?? []).forEach((table, tableIndex) => {
    parts[`xl/tables/table${String(tableIndex)}.xml`] = strToU8(
      '<?xml version="1.0"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        `id="${String(tableIndex + 1)}" name="${table.name}" displayName="${table.name}" ref="${table.ref}"></table>`,
    );
    parts[`xl/worksheets/_rels/sheet${String(table.sheetIndex)}.xml.rels`] = strToU8(
      "<?xml version=\"1.0\"?><Relationships>" +
        `<Relationship Id="rIdTable${String(tableIndex)}" Type="${REL_TYPE_TABLE}" ` +
        `Target="../tables/table${String(tableIndex)}.xml"/></Relationships>`,
    );
  });

  return zipSync(parts);
}
