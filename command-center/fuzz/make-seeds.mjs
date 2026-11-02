// Regenerates the small committed seeds in fuzz/corpus/<target>/ from real inputs: the checklist
// fixtures the importer tests use, task text in every format the parser reads, due values, rules,
// and a backup container encrypted by the app's own code.
//   node fuzz/make-seeds.mjs      (npm run fuzz:seeds)
// Not run in CI. The seeds are committed, so this only needs re-running when a format a target
// reads changes. Seeds are plain ASCII on purpose: fuzz/corpus is not one of the fixture folders
// that keep emoji as coverage.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { encryptFile } from '../src/daemon/backupCrypto.ts';
import { root } from './bundle.mjs';
import { BACKUP_PASSPHRASE } from './targets/expected.ts';

const corpus = (name) => {
  const dir = path.join(root, 'fuzz/corpus', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
};
const write = (dir, file, content) => writeFileSync(path.join(dir, file), content);
const selector = (byte, text) => Buffer.concat([Buffer.from([byte]), Buffer.from(text, 'utf8')]);

// checklist: the importer's own fixtures, plus a document with the shapes the parser branches on.
const checklist = corpus('checklist');
const fixtures = path.join(root, 'src/importer/fixtures');
write(checklist, 'sample-initiative.md', readFileSync(path.join(fixtures, 'full-repo/initiatives/sample-initiative.md')));
write(checklist, 'project-status.md', readFileSync(path.join(fixtures, 'full-repo/PROJECT_STATUS.md')));
write(checklist, 'shapes.md', [
  '# Title', '', '## Section', '', '- [ ] First step', '  with a note', '', '  and a paragraph', '  - [x] Done child', '    - [ ] Grandchild',
  '* [X] Star bullet', '', '### Sub', '', '```', '- [ ] inside a fence, not an item', '```', '', '- [ ] After the fence', 'plain text ends the note', '',
].join('\n'));

// task-text: selector byte (format), then the text.
const taskText = corpus('task-text');
write(taskText, 'lines.txt', selector(2, ['Buy milk', '- Call the vet', '  - [ ] Ask about the invoice', '    - [x] Pay it', '* Plain star', '# Heading', '', '- Last'].join('\n')));
write(taskText, 'csv-comma.csv', selector(1, ['title,priority,due,notes,project', 'Buy milk,high,2026-01-15,"a note, quoted",home', 'Call the vet,,2026-02-01 09:00,,', '"Title with ""quotes""",low,,,'].join('\r\n')));
write(taskText, 'csv-semicolon.csv', selector(0, ['Name;Due date;Estimate (minutes)', 'Plan the week;2026-01-19;30', 'Write the report;2026-01-20T14:00;90'].join('\n')));
write(taskText, 'auto-lines.txt', selector(0, ['Just one line', 'and another'].join('\n')));

// due: selector byte (timezone), then a value.
const due = corpus('due');
for (const [i, v] of ['2026-01-15', '2026-01-15 09:30', '2026-01-15T9:05', '2026-01-15T09:30:00Z', '2026-01-15T09:30:15.250+05:30', '2026-01-15T00:00:00Z', 'next tuesday'].entries()) {
  write(due, `value-${i}.txt`, selector(i, v));
}

// recurrence: selector byte (previous due), then the rule.
const recurrence = corpus('recurrence');
for (const [i, r] of ['FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=31', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', 'FREQ=DAILY;INTERVAL=3;UNTIL=20270101', 'weekly', 'every 2 weeks', 'FREQ=MONTHLY;INTERVAL=2;X-FROM=COMPLETION', 'FREQ=MONTHLY;BYDAY=-1FR;WKST=SU'].entries()) {
  write(recurrence, `rule-${i}.txt`, selector(i, r));
}

// pattern: pattern, NUL, text. The last one makes RegExp, the reference, backtrack for seconds
// (review of #112): it stays in the corpus so every run proves the bounded oracle holds.
const pattern = corpus('pattern');
for (const [i, [p, t]] of [['^(a|b)+c?$', 'ababc'], ['\\bfix(es|ed)?\\b', 'this fixes it'], ['[^\\d\\s]{2,5}x*', 'ab12 cdx'], ['(?:foo|bar){1,}baz.', 'foobarbaz!'], ['a*?b+?', 'aaab'], ['^((a*)*)*$', `${'a'.repeat(23)}!`]].entries()) {
  write(pattern, `pattern-${i}.txt`, Buffer.concat([Buffer.from(p), Buffer.from([0]), Buffer.from(t)]));
}

// rules: rule definitions as the dashboard sends them.
const rules = corpus('rules');
write(rules, 'set-priority.json', JSON.stringify({ trigger: { type: 'event', kinds: ['task.created'] }, conditions: [{ field: 'title', op: 'matches', value: '^urgent' }], actions: [{ type: 'set_field', field: 'priority', value: 'high' }] }, null, 2));
write(rules, 'followup.json', JSON.stringify({ trigger: { type: 'event', kinds: ['task.completed'] }, conditions: [{ field: 'projectId', op: 'in', value: ['p1', 'p2'] }, { field: 'dueAt', op: 'before', value: '2026-01-15' }], actions: [{ type: 'create_followup', title: 'Review {title}', dueInDays: 7 }, { type: 'notify', message: 'done' }] }, null, 2));
write(rules, 'move.json', JSON.stringify({ trigger: { type: 'schedule', condition: 'overdue' }, actions: [{ type: 'move', project: 'inbox', section: 'later' }, { type: 'add_comment', body: 'moved' }] }));
write(rules, 'due-soon.json', JSON.stringify({ trigger: { type: 'schedule', condition: 'due_within_days', days: 3 }, conditions: [{ field: 'status', op: 'eq', value: 'open' }], actions: [{ type: 'notify', message: 'due soon' }] }));
write(rules, 'stale.json', JSON.stringify({ trigger: { type: 'schedule', condition: 'stale_days', days: 14 }, conditions: [{ field: 'customField:area', op: 'exists' }], actions: [{ type: 'set_field', field: 'customField', key: 'area', value: 'review' }] }));

// post-fence: bodies with backtick runs and newlines.
const fence = corpus('post-fence');
write(fence, 'plain.txt', 'A plain claim with no code.');
write(fence, 'fenced.txt', 'Here is code:\n```js\nconsole.log(1)\n```\nand ````\n`````\ninline `code` too');

// backup: a real container at the smallest scrypt cost the reader accepts, so the fuzzer starts
// from an input that authenticates and has the full header to mutate.
const backup = corpus('backup');
const scratch = mkdtempSync(path.join(tmpdir(), 'polaris-fuzz-seed-'));
try {
  const plain = path.join(scratch, 'plain.sqlite');
  writeFileSync(plain, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(240)]));
  const enc = path.join(scratch, 'plain.sqlite.enc');
  encryptFile(plain, enc, BACKUP_PASSPHRASE, { logN: 10 });
  write(backup, 'small.sqlite.enc', readFileSync(enc));
  write(backup, 'header-only.enc', readFileSync(enc).subarray(0, 36));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

for (const t of readdirSync(path.join(root, 'fuzz/corpus'))) {
  const dir = path.join(root, 'fuzz/corpus', t);
  const sizes = readdirSync(dir).map((n) => readFileSync(path.join(dir, n)).length);
  console.log(`${t}: ${sizes.length} seeds, largest ${Math.max(...sizes)} bytes`);
}
