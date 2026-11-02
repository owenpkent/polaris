import { MAX_IMPORT_ROWS, parseTaskText, type ImportFormat } from '../../src/importer/taskText.ts';

const FORMATS: ImportFormat[] = ['auto', 'csv', 'lines'];

// Bulk task import reads text the owner pasted or an agent sent: lines, bullets, checkboxes, or
// CSV. The first byte picks the format and the rest is the text. Total by design: a throw is a
// finding, and so is a row the store cannot take (no title, a parent that comes later, more rows
// than the cap) or a line number that runs backwards.
export function fuzz(data: Buffer): void {
  const format = FORMATS[(data[0] ?? 0) % FORMATS.length];
  const text = data.subarray(1).toString('utf8');
  const { rows, errors } = parseTaskText(text, format);
  if (rows.length > MAX_IMPORT_ROWS) throw new Error(`${rows.length} rows over the cap`);
  rows.forEach((row, i) => {
    if (!row.title.trim()) throw new Error(`row ${i} has a blank title`);
    if (row.parentIndex !== null && (row.parentIndex < 0 || row.parentIndex >= i)) throw new Error(`row ${i} has parent ${row.parentIndex}`);
    if (row.line < 1 || (i > 0 && row.line < rows[i - 1].line)) throw new Error(`row ${i} at line ${row.line}`);
  });
  for (const e of errors) if (e.line < 0) throw new Error(`error at line ${e.line}`);
}
