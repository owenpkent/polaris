import { checklistToSourceItems, parseChecklist } from '../../src/importer/checklist.ts';

// The checklist parser reads README, todo and docs files from tracked GitHub repos: text the
// owner did not write. It is total by design, so any throw is a finding, and so is a shape the
// store relies on going wrong: line numbers that run backwards, a parent that comes later than its
// child, a depth that does not follow the parent, or two items in one file with the same source id.
export function fuzz(data: Buffer): void {
  const text = data.toString('utf8');
  const items = parseChecklist(text);
  const lineCount = text.split(/\r\n|\r|\n/).length;
  items.forEach((item, i) => {
    if (item.line < 1 || item.line > lineCount) throw new Error(`item ${i} at line ${item.line} of ${lineCount}`);
    if (i > 0 && item.line <= items[i - 1].line) throw new Error(`item ${i} at line ${item.line} after line ${items[i - 1].line}`);
    if (item.parentIndex === null) {
      if (item.depth !== 0) throw new Error(`item ${i} has no parent but depth ${item.depth}`);
    } else {
      if (item.parentIndex < 0 || item.parentIndex >= i) throw new Error(`item ${i} has parent ${item.parentIndex}`);
      if (item.depth !== items[item.parentIndex].depth + 1) throw new Error(`item ${i} depth ${item.depth} under depth ${items[item.parentIndex].depth}`);
    }
  });
  const sourced = checklistToSourceItems(text, 'proj', 'TODO.md');
  if (new Set(sourced.map((s) => s.sourceId)).size !== sourced.length) throw new Error('duplicate source id in one file');
}
