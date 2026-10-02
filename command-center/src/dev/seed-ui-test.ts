// Adds what the demo seed (seed-demo.ts) leaves out, so the UI tests in e2e/ can exercise the
// Board, Rules, and Goals views: one project with two sections and four cards, one rule saved
// disabled (the way an agent-created rule arrives), and two goals. Also adds a second project,
// "UI Test Text", holding three open tasks with long or awkward titles (a 300-character
// unbroken title, a right-to-left title, and a URL title) so the overflow checks in
// accessibility.spec.js have something to open, without touching the first project's board.
// Run it after seed-demo.ts, so the demo tasks stay without a project. Refuses the real database.
import { resolve } from 'node:path';
import { openStore } from '../core/index.ts';
import { loadConfig } from '../config.ts';

const config = loadConfig();
const realDb = resolve(config.repoRoot, 'command-center', 'data', 'constellation.db');
if (!process.env.CC_DB || resolve(config.dbPath) === realDb) {
  console.error('Set CC_DB to a scratch database before seeding UI test data.');
  process.exit(1);
}

const store = openStore(config.dbPath);

const project = store.upsertProject({
  slug: 'ui-test-project',
  name: 'UI Test Project',
  category: 'software',
  type: 'Software',
  description: 'Project used only by the UI tests.',
  status: 'active',
});
const backlog = store.ensureSection(project.id, 'Backlog');
const doing = store.ensureSection(project.id, 'Doing');

store.createTask({ title: 'Board card alpha', projectId: project.id, sectionId: backlog.id, priority: 'high' });
store.createTask({ title: 'Board card beta', projectId: project.id, sectionId: backlog.id, priority: 'none' });
store.createTask({ title: 'Board card gamma', projectId: project.id, sectionId: doing.id, priority: 'low' });

store.saveRule({
  name: 'Notify when a task is overdue',
  enabled: false,
  definition: {
    trigger: { type: 'schedule', condition: 'overdue' },
    conditions: [],
    actions: [{ type: 'notify', message: 'overdue: {title}' }],
  },
});

// Two inbox suggestions no test accepts or rejects. inbox.spec.js uses up the demo seed's four,
// so without these the inbox is empty for anything that runs after it (the phone tab bar's count).
for (const [i, title] of ['Issue assigned: spare suggestion one', 'Issue assigned: spare suggestion two'].entries()) {
  store.upsertFromSource({
    sourceType: 'github', sourceId: `ui-test-spare-${i}`, title, notes: 'UI test suggestion.',
    sourceUrl: `https://github.com/example/demo/issues/${100 + i}`, dueAt: null, projectId: null, contentHash: `ui-test-spare-${i}`,
  });
}

// Goals: one linked to the project (so it has open work and a milestone to count), and one with
// nothing linked (so the UI tests have a stalled goal to find).
const milestone = store.createTask({ title: 'Board milestone delta', projectId: project.id, sectionId: doing.id, isMilestone: true });
const shipIt = store.createGoal({ title: 'Ship the UI test project', periodLabel: '2026', startsOn: '2026-01-01', endsOn: '2026-12-31' });
store.linkGoal(shipIt.id, { projectId: project.id });
store.createGoal({ title: 'Grow the audience', progressMode: 'manual', currentValue: 250, targetValue: 1000, unit: 'subscribers' });
void milestone;

// A second project, kept apart from "UI Test Project" so its board lanes and card lists stay
// exactly as the Board tests expect. Three open tasks, no section, no due date, each with a
// title that is long or awkward in a different way (Phase 5, "long and awkward text").
const textProject = store.upsertProject({
  slug: 'ui-test-text',
  name: 'UI Test Text',
  category: 'software',
  type: 'Software',
  description: 'Project used only by the UI tests for long and awkward task titles.',
  status: 'active',
});

const longTitle = 'Polaris'.repeat(43).slice(0, 300);
const rtlTitle = 'هذه مهمة تجريبية لفحص التخطيط من اليمين إلى اليسار';
const urlTitle =
  'https://example.com/' +
  'a/very/long/path/that/keeps/going/to/check/how/the/dashboard/handles/an/unbroken/url/' +
  'as/a/task/title/without/wrapping/or/causing/horizontal/scroll/on/a/narrow/phone/screen';

store.createTask({
  title: longTitle,
  notes: 'Checks that a single 300-character word with no spaces never widens the page.',
  projectId: textProject.id,
});
store.createTask({
  title: rtlTitle,
  notes: 'Checks that a right-to-left title lays out and opens correctly.',
  projectId: textProject.id,
});
store.createTask({
  title: urlTitle,
  notes: 'Checks that a long URL used as a title never widens the page.',
  projectId: textProject.id,
});

console.log(`Seeded project "${project.name}" with 2 sections, 4 cards, 1 disabled rule, 2 inbox suggestions, and 2 goals into ${config.dbPath}`);
console.log(`Seeded project "${textProject.name}" with 3 open tasks (long, RTL, and URL titles) into ${config.dbPath}`);
