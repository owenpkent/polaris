// Adds a project sized for a perceived-performance check: 200 board cards spread across two
// sections, plus enough plain tasks that My tasks renders 500 open rows in total (the 200 cards
// count toward the 500; the rest carry no section, but stay in this project). Run after
// seed-demo.ts and seed-ui-test.ts, and only when CC_UI_PERF=1 (e2e/global-setup.js), since
// nothing else needs this many rows. initiatives/ui-ux-testing.md, "Perceived performance,
// report only". Refuses the real database.
import { resolve } from 'node:path';
import { openStore } from '../core/index.ts';
import { PRIORITIES } from '../core/types.ts';
import { loadConfig } from '../config.ts';

const config = loadConfig();
const realDb = resolve(config.repoRoot, 'command-center', 'data', 'constellation.db');
if (!process.env.CC_DB || resolve(config.dbPath) === realDb) {
  console.error('Set CC_DB to a scratch database before seeding perf data.');
  process.exit(1);
}

const store = openStore(config.dbPath);

const project = store.upsertProject({
  slug: 'ui-perf-project',
  name: 'UI Perf Project',
  category: 'software',
  type: 'Software',
  description: 'Project used only by the report-only performance spec.',
  status: 'active',
});
const sectionA = store.ensureSection(project.id, 'To do');
const sectionB = store.ensureSection(project.id, 'In progress');

function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const TOTAL = 500;
const CARDS = 200;
for (let i = 0; i < TOTAL; i++) {
  const title = `Perf task ${String(i + 1).padStart(4, '0')}`;
  // A third with no due date, the rest spread over the next 60 days.
  const dueAt = i % 3 === 0 ? null : day(1 + (i % 60));
  const priority = PRIORITIES[i % PRIORITIES.length];
  // The first 200 tasks are cards, split evenly between the two sections; the rest have no section.
  const sectionId = i < CARDS / 2 ? sectionA.id : i < CARDS ? sectionB.id : null;
  store.createTask({ title, projectId: project.id, sectionId, dueAt, priority });
}

console.log(`Seeded project "${project.name}" with 2 sections, ${CARDS} cards, and ${TOTAL} open tasks into ${config.dbPath}`);
