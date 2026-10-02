import { test, expect } from './fixtures.js'
import { openView, isPhone, listTaskTitles, smallTargets, expectNoHorizontalOverflow } from './support.js'
import { TOKEN } from './global-setup.js'

// The test server's GitHub is the fake in command-center/src/dev/githubFake.ts, switched on by
// CC_GITHUB_FAKE=1 in global-setup.js. The names here are its fixtures (the demo seed's two
// repos are listed too, readable and empty). The desktop and phone runs share one database, so
// each tracks its own readable repo, and the unreadable repo is only ever switched on, never off,
// so the two runs never undo each other.
const USER = 'ui-test-user'
const READABLE = { desktop: 'ui-test/readable-desktop', phone: 'ui-test/readable-phone' }
const UNREADABLE = 'ui-test/unreadable'
const ALL_REPOS = [READABLE.desktop, READABLE.phone, UNREADABLE]
const repoName = (fullName) => fullName.split('/')[1]
// A checklist is the owner's own file, so its items become open tasks of the project (importer/todo.ts).
const readmeItems = (fullName) => [`Write the release notes for ${repoName(fullName)}`, `Tag the ${repoName(fullName)} release`]
// The repo's one open issue, third-party text, which only ever reaches the inbox.
const issueTitle = (fullName) => `The ${repoName(fullName)} sidebar overlaps the board`

const ownRepo = (testInfo) => READABLE[testInfo.project.name] || READABLE.desktop
const auth = { Authorization: `Bearer ${TOKEN}` }
const trackSwitch = (page, fullName) => page.getByRole('switch', { name: `Track ${fullName} as a project` })
const syncIssuesSwitch = (page, fullName) => page.getByRole('switch', { name: `Sync issues and PRs for ${fullName}` })

async function setSwitch(control, on) {
  if ((await control.getAttribute('aria-checked')) !== String(on)) await control.click()
  await expect(control).toHaveAttribute('aria-checked', String(on))
}

// The dashboard's own way to track a repo (api.js updateGithubRepo), for tests that need the
// project to exist before they start.
async function trackRepo(request, fullName, patch = { tracked: true }) {
  const res = await request.patch(`/api/github/repos/${fullName}`, { headers: auth, data: patch })
  expect(res.ok(), `track ${fullName}: ${res.status()}`).toBeTruthy()
}

async function jobStatus(request, job) {
  const res = await request.get('/api/sync', { headers: auth })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).jobs[job] || { lastRunAt: null, lastError: null, running: false }
}

// Starts one sync job the way the dashboard's API client does (api.js runSync, POST /api/sync/:job)
// and waits for it to finish. Returns its status so a test can read lastError.
async function runSync(request, job) {
  const before = await jobStatus(request, job)
  const res = await request.post(`/api/sync/${job}`, { headers: auth })
  expect(res.status(), `start ${job}`).toBe(202)
  await expect
    .poll(async () => {
      const s = await jobStatus(request, job)
      return !s.running && (s.lastRunAt !== before.lastRunAt || s.lastError) ? s : null
    }, { timeout: 15000 })
    .not.toBeNull()
  return jobStatus(request, job)
}

async function projectForRepo(request, fullName) {
  const res = await request.get('/api/projects?includeArchived=1', { headers: auth })
  expect(res.ok()).toBeTruthy()
  const { projects } = await res.json()
  return projects.find((p) => p.github && p.github.toLowerCase().endsWith(`/${fullName.toLowerCase()}`))
}

async function projectTaskTitles(request, projectId) {
  const res = await request.get(`/api/projects/${projectId}`, { headers: auth })
  expect(res.ok()).toBeTruthy()
  const { tasks } = await res.json()
  return tasks.map((t) => t.title)
}

test.describe('GitHub', { tag: ['@flow'] }, () => {
  test('shows the signed-in user and the repos the App can see', async ({ page }) => {
    await openView(page, 'github')
    const main = page.getByRole('main')
    await expect(main).toContainText(`Read-only, signed in as ${USER}.`)
    await expect(main).toContainText(`Signed in as ${USER}`)
    for (const fullName of ALL_REPOS) {
      await expect(page.getByRole('cell', { name: fullName, exact: true })).toBeVisible()
      await expect(trackSwitch(page, fullName)).toBeVisible()
    }
  })

  test('Track as project makes the repo a project, and its README checklist becomes its tasks', async ({ page, request }, testInfo) => {
    const fullName = ownRepo(testInfo)
    await openView(page, 'github')
    await setSwitch(trackSwitch(page, fullName), true)
    await expect(page.getByRole('cell', { name: repoName(fullName), exact: true })).toBeVisible()
    await expect(syncIssuesSwitch(page, fullName)).toBeEnabled()

    await openView(page, 'projects')
    await expect(page.getByRole('article', { name: repoName(fullName), exact: true })).toBeVisible()

    const files = await runSync(request, 'repo-files')
    expect(files.lastError).toBeNull()
    const project = await projectForRepo(request, fullName)
    expect(project).toBeTruthy()
    expect(project.archived).toBeFalsy()
    const titles = await projectTaskTitles(request, project.id)
    for (const item of readmeItems(fullName)) expect(titles).toContain(item)
  })

  test('the tracked repo\'s open issue arrives in the Inbox as a GitHub suggestion, not as a task', async ({ page, request }, testInfo) => {
    const fullName = ownRepo(testInfo)
    await trackRepo(request, fullName)
    const issues = await runSync(request, 'github')
    expect(issues.lastError).toBeNull()

    await openView(page, 'inbox')
    const link = page.getByRole('link', { name: issueTitle(fullName), exact: true })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', `https://github.com/${fullName}/issues/1`)
    // One inbox entry: a table row on desktop, a card (list item) on the phone, as in inbox.spec.js.
    const entry = page.getByRole(isPhone(testInfo) ? 'listitem' : 'row').filter({ has: link })
    await expect(entry).toContainText('GitHub')
    expect(await listTaskTitles(request)).not.toContain(issueTitle(fullName))
  })

  test('switching Track as project off archives the project and keeps its tasks', async ({ page, request }, testInfo) => {
    const fullName = ownRepo(testInfo)
    await trackRepo(request, fullName)
    await runSync(request, 'repo-files')
    const before = await projectForRepo(request, fullName)
    expect(before.archived).toBeFalsy()
    const tasksBefore = await projectTaskTitles(request, before.id)
    for (const item of readmeItems(fullName)) expect(tasksBefore).toContain(item)

    await openView(page, 'github')
    await setSwitch(trackSwitch(page, fullName), false)
    await expect(syncIssuesSwitch(page, fullName)).toBeDisabled()

    await expect.poll(async () => (await projectForRepo(request, fullName)).archived).toBeTruthy()
    const after = await projectForRepo(request, fullName)
    expect(after.id).toBe(before.id)
    expect(await projectTaskTitles(request, after.id)).toEqual(tasksBefore)
    const listed = await request.get('/api/projects', { headers: auth })
    expect((await listed.json()).projects.map((p) => p.id)).not.toContain(before.id)

    // Back on, so the other run and the shots find the repo as a project again.
    await setSwitch(trackSwitch(page, fullName), true)
    await expect.poll(async () => (await projectForRepo(request, fullName)).archived).toBeFalsy()
  })

  test('a repo the App cannot read is skipped and creates nothing', async ({ page, request }) => {
    await openView(page, 'github')
    await setSwitch(trackSwitch(page, UNREADABLE), true)
    // The issue sync has no readability check of its own, so its switch goes off for this repo;
    // the checklist reader checks the repo first and reports it as skipped.
    await setSwitch(syncIssuesSwitch(page, UNREADABLE), false)

    const files = await runSync(request, 'repo-files')
    expect(files.lastError).toBeNull()
    const issues = await runSync(request, 'github')
    expect(issues.lastError).toBeNull()

    const project = await projectForRepo(request, UNREADABLE)
    expect(project).toBeTruthy()
    expect(await projectTaskTitles(request, project.id)).toEqual([])
    const inbox = await request.get('/api/inbox', { headers: auth })
    expect((await inbox.json()).tasks.filter((t) => t.projectId === project.id)).toEqual([])
  })

  test('every control is a 44px target and the page never scrolls sideways', async ({ page }) => {
    await openView(page, 'github')
    await expect(trackSwitch(page, UNREADABLE)).toBeVisible()
    const main = page.getByRole('main')
    expect(await smallTargets(main, 'button, [role="button"], [role="switch"], a[href], input, select'), 'controls under 44px').toEqual([])
    await expectNoHorizontalOverflow(page)
  })
})
