// Unit tests for api/src/excel-leads.js (Excel/.xlsx bulk lead import -
// see that module's header comment for why this exists as a separate,
// independently-testable module rather than inline in server.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { buildBlankTemplate, parseLeadsWorkbook, cellToString, TEMPLATE_HEADERS } = require('../src/excel-leads');

test('buildBlankTemplate produces a workbook whose header row matches TEMPLATE_HEADERS', async () => {
  const buffer = await buildBlankTemplate();
  assert.ok(Buffer.isBuffer(buffer) || buffer instanceof Uint8Array);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  const headerValues = ws.getRow(1).values.slice(1); // index 0 is always undefined when *read*
  assert.deepEqual(headerValues, TEMPLATE_HEADERS);
});

test('buildBlankTemplate formats the Phone column as text, not a number', async () => {
  const buffer = await buildBlankTemplate();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  const phoneCol = ws.getColumn(3); // Company Name, Contact Name, Phone
  assert.equal(phoneCol.style.numFmt, '@');
});

test('cellToString coerces plain values', () => {
  assert.equal(cellToString(null), '');
  assert.equal(cellToString(undefined), '');
  assert.equal(cellToString('hello'), 'hello');
  assert.equal(cellToString(50000), '50000');
  assert.equal(cellToString(0), '0');
});

test('cellToString flattens rich text runs to their concatenated text', () => {
  assert.equal(cellToString({ richText: [{ text: 'Hello ' }, { text: 'World' }] }), 'Hello World');
});

test('cellToString extracts the visible text of a hyperlink cell', () => {
  assert.equal(cellToString({ text: 'acme.in', hyperlink: 'https://acme.in' }), 'acme.in');
});

test('cellToString follows a formula cell to its computed result', () => {
  assert.equal(cellToString({ formula: 'A1&B1', result: 'AcmeCo' }), 'AcmeCo');
  assert.equal(cellToString({ formula: 'A1&B1', result: 42 }), '42');
});

test('cellToString returns empty string for an error cell rather than throwing', () => {
  assert.equal(cellToString({ error: '#REF!' }), '');
});

test('cellToString renders a date as a plain YYYY-MM-DD string', () => {
  assert.equal(cellToString(new Date('2026-03-15T00:00:00.000Z')), '2026-03-15');
});

test('parseLeadsWorkbook round-trips a filled-in copy of the template', async () => {
  const buffer = await buildBlankTemplate();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];

  ws.getRow(2).values = undefined; // clear the pre-added blank row first
  ws.spliceRows(2, 1,
    ['Acme Pvt Ltd', 'Rahul Sharma', '9876543210', 'rahul@acme.in', 50000, 'Interested in bulk order'],
    ['Beta Co', '', '08123456789', '', '', '']
  );
  // Leave one fully-blank row (common at the end of a hand-edited sheet) -
  // the template already has 18 more blank rows after the two we just set.

  const outBuffer = await wb.xlsx.writeBuffer();
  const records = await parseLeadsWorkbook(outBuffer);

  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    'Company Name': 'Acme Pvt Ltd',
    'Contact Name': 'Rahul Sharma',
    'Phone': '9876543210',
    'Email': 'rahul@acme.in',
    'Value (INR)': '50000',
    'Note': 'Interested in bulk order'
  });
  assert.equal(records[1]['Company Name'], 'Beta Co');
  assert.equal(records[1]['Phone'], '08123456789');
  assert.equal(records[1]['Email'], '');
});

test('parseLeadsWorkbook throws a plain, user-facing error for a non-workbook buffer', async () => {
  await assert.rejects(
    () => parseLeadsWorkbook(Buffer.from('not an excel file at all')),
    /Could not read this file as an Excel/
  );
});

test('parseLeadsWorkbook throws when the first row has no usable header text', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['', '', '']);
  const buffer = await wb.xlsx.writeBuffer();
  await assert.rejects(
    () => parseLeadsWorkbook(buffer),
    /first row must be a header row/
  );
});

test('parseLeadsWorkbook ignores a header column with a blank name', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Company Name', '', 'Phone']);
  ws.addRow(['Acme', 'ignored', '12345']);
  const buffer = await wb.xlsx.writeBuffer();
  const records = await parseLeadsWorkbook(buffer);
  assert.deepEqual(records, [{ 'Company Name': 'Acme', 'Phone': '12345' }]);
});

test('parseLeadsWorkbook uses only the first worksheet when several exist', async () => {
  const wb = new ExcelJS.Workbook();
  const ws1 = wb.addWorksheet('Leads');
  ws1.addRow(['Company Name']);
  ws1.addRow(['Acme']);
  const ws2 = wb.addWorksheet('Notes');
  ws2.addRow(['Should not appear']);
  const buffer = await wb.xlsx.writeBuffer();
  const records = await parseLeadsWorkbook(buffer);
  assert.deepEqual(records, [{ 'Company Name': 'Acme' }]);
});
