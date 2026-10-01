'use strict';
// Excel (.xlsx) support for bulk lead import - the same shape CSV import
// already uses, just a different file format in. Pulled into its own
// module for the same reason csv-leads.js was: pure functions (buffer in,
// plain objects out - no DB, no request/response, no filesystem), so
// they're independently unit-testable without a running server (see
// api/test/ and README.md "Hardening notes" on why server.js itself
// can't be required from a test).
//
// parseLeadsWorkbook() deliberately returns the exact same shape
// csv-parse's `columns: true` option gives POST /leads/upload-csv - an
// array of plain objects keyed by the file's own header row, values
// coerced to strings - so POST /leads/upload-excel (server.js) can feed
// its output straight into the existing processLeadCsvRecords()
// (csv-leads.js) unchanged. One validation/sanitization/dedup path for
// both file formats, not two to keep in sync.
const ExcelJS = require('exceljs');

const TEMPLATE_HEADERS = ['Company Name', 'Contact Name', 'Phone', 'Email', 'Value (INR)', 'Note'];

// Builds the blank template a user downloads before filling in their own
// leads. The Phone column is formatted as text (not a number) so Excel
// doesn't silently mangle a number typed with a leading 0 or a + prefix,
// strip leading zeros, or flip a long number into scientific notation -
// the single most common way a spreadsheet full of real-looking phone
// numbers turns into garbage before it's ever uploaded anywhere.
function buildBlankTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Octave AI Automation';
  wb.created = new Date();
  const ws = wb.addWorksheet('Leads');

  const headerRow = ws.addRow(TEMPLATE_HEADERS);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.columns = [
    { width: 28 }, // Company Name
    { width: 22 }, // Contact Name
    { width: 18, style: { numFmt: '@' } }, // Phone - '@' = text format
    { width: 28 }, // Email
    { width: 16 }, // Value (INR)
    { width: 40 } // Note
  ];
  // A couple of blank, pre-formatted rows so the Phone column's text
  // format is visibly already applied when someone opens the file and
  // starts typing - Excel only applies a column's style to cells that
  // exist, not purely by column definition, in every version/viewer.
  for (let i = 0; i < 20; i++) ws.addRow([]);

  return wb.xlsx.writeBuffer();
}

// Coerces one ExcelJS cell value to a plain string, the same type every
// CSV cell already is by the time csv-parse hands it to
// processLeadCsvRecords(). ExcelJS hands back rich shapes for anything
// that isn't a bare string/number - rich text runs, hyperlinks, formula
// results, dates - this flattens all of them to the text a human actually
// sees in that cell, rather than passing an object through and having it
// render as "[object Object]" once it reaches a lead record.
function cellToString(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text || '').join('');
    if (typeof value.text === 'string') return value.text; // hyperlink cell: { text, hyperlink }
    if ('result' in value) return cellToString(value.result); // formula cell: { formula, result }
    if ('error' in value) return ''; // a #REF!/#DIV0! etc error cell - nothing usable to import
    return '';
  }
  return String(value);
}

// Parses the first worksheet of an uploaded .xlsx into the same
// [{header: value}, ...] shape csv-parse's columns:true produces. Throws
// a plain, user-facing Error (caught by the route and returned as a 400)
// for anything that isn't a usable leads workbook - never silently
// returns an empty/partial result for a file that looks wrong.
async function parseLeadsWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (e) {
    throw new Error('Could not read this file as an Excel (.xlsx) workbook.');
  }

  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 1) {
    throw new Error('The workbook has no worksheets with any data in them.');
  }

  const headerCells = ws.getRow(1).values; // 1-indexed; values[0] is always undefined
  const headers = [];
  for (let col = 1; col < headerCells.length; col++) {
    const h = cellToString(headerCells[col]).trim();
    if (h) headers.push({ col, name: h });
  }
  if (!headers.length) {
    throw new Error('The first row must be a header row (e.g. "Company Name", "Phone", "Email").');
  }

  const records = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const rowValues = row.values;
    const record = {};
    let hasAnyValue = false;
    for (const { col, name } of headers) {
      const cellValue = cellToString(rowValues[col]);
      if (cellValue) hasAnyValue = true;
      record[name] = cellValue;
    }
    if (hasAnyValue) records.push(record); // skip fully-blank rows (common at the end of a hand-edited sheet)
  });

  return records;
}

module.exports = { buildBlankTemplate, parseLeadsWorkbook, cellToString, TEMPLATE_HEADERS };
