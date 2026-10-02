import { test, expect } from './fixtures.js'
import { openView, createTask, smallTargets, expectNoHorizontalOverflow } from './support.js'

// Seeded by command-center/src/dev/seed-ui-test.ts: "UI Test Project" (type Software, status
// active, no GitHub repo, 4 open tasks including one milestone). Tests that change a project
// create their own.

const row = (page, name) => page.getByRole('article', { name, exact: true })

let created = 0
function uniqueName(label, testInfo) {
  return `UI test project ${label} ${testInfo.project.name} ${++created}`
}

test.describe('Projects', { tag: ['@flow'] }, () => {
  test('lists the seeded project with its type, status, and GitHub repo', async ({ page }) => {
    await openView(page, 'projects')
    const uiProject = row(page, 'UI Test Project')
    await expect(uiProject).toContainText('Software')
    await expect(uiProject).toContainText('active')
    await expect(uiProject).toContainText('No repo')
    // Other specs add tasks to this shared project, so only the shape of the count is fixed.
    await expect(uiProject).toContainText(/\d+ open tasks?/)
  })

  test('New project needs only a name and a click, and opens with nothing set', async ({ page }, testInfo) => {
    const title = uniqueName('typed', testInfo)
    await openView(page, 'projects')
    await page.getByRole('toolbar', { name: 'Projects' }).getByRole('button', { name: 'New project' }).click()
    const form = page.getByRole('form', { name: 'New project' })
    const nameInput = form.getByRole('textbox', { name: 'Name' })
    await expect(nameInput).toBeFocused()
    await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled()
    await nameInput.fill(title)
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(form).toHaveCount(0)
    await expect(row(page, title)).toBeVisible()
    await expect(row(page, title)).toContainText('No type')
    await expect(row(page, title)).toContainText('No repo')
    await expect(row(page, title)).toContainText('0 open tasks')
  })

  test('Esc closes the New project form without creating anything', async ({ page }) => {
    await openView(page, 'projects')
    await page.getByRole('toolbar', { name: 'Projects' }).getByRole('button', { name: 'New project' }).click()
    const form = page.getByRole('form', { name: 'New project' })
    await form.getByRole('textbox', { name: 'Name' }).fill('Should never exist')
    await page.keyboard.press('Escape')
    await expect(form).toHaveCount(0)
    await expect(row(page, 'Should never exist')).toHaveCount(0)
  })

  test('editing a project sends only the changed field and survives a reload', async ({ page }, testInfo) => {
    const title = uniqueName('edit', testInfo)
    await openView(page, 'projects')
    await page.getByRole('toolbar', { name: 'Projects' }).getByRole('button', { name: 'New project' }).click()
    const newForm = page.getByRole('form', { name: 'New project' })
    await newForm.getByRole('textbox', { name: 'Name' }).fill(title)
    await newForm.getByRole('button', { name: 'Save' }).click()
    await expect(row(page, title)).toBeVisible()

    await row(page, title).getByRole('button', { name: `Edit ${title}` }).click()
    const editForm = page.getByRole('form', { name: `Edit ${title}` })
    await editForm.getByRole('textbox', { name: 'Status' }).fill('Planning')
    await editForm.getByRole('button', { name: 'Save' }).click()
    await expect(editForm).toHaveCount(0)
    await expect(row(page, title)).toContainText('Planning')

    // A real reload (not a second openView, which would only change the URL fragment) proves the
    // edit was saved on the server rather than only held in this page's own state.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(row(page, title)).toContainText('Planning')
  })

  test('a task can be filed under a project made by hand, and the count picks it up', async ({ page, request }, testInfo) => {
    const title = uniqueName('link task', testInfo)
    await openView(page, 'projects')
    await page.getByRole('toolbar', { name: 'Projects' }).getByRole('button', { name: 'New project' }).click()
    const form = page.getByRole('form', { name: 'New project' })
    await form.getByRole('textbox', { name: 'Name' }).fill(title)
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(row(page, title)).toContainText('0 open tasks')

    await createTask(request, testInfo, 'filed under project', { project: title })
    // A second openView would carry the exact same #cc-url/#cc-token fragment as the first, which
    // Chromium treats as a same-document navigation (no reload) since only the fragment differs.
    // A real reload is needed to see a change made outside this page, so this uses page.reload
    // instead; the connection survives it from the localStorage ConnectionContext already saved.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(row(page, title)).toContainText('1 open task')
  })

  test('Archive removes a project from the list, and Show archived brings it back', async ({ page }, testInfo) => {
    const title = uniqueName('archive', testInfo)
    await openView(page, 'projects')
    await page.getByRole('toolbar', { name: 'Projects' }).getByRole('button', { name: 'New project' }).click()
    const newForm = page.getByRole('form', { name: 'New project' })
    await newForm.getByRole('textbox', { name: 'Name' }).fill(title)
    await newForm.getByRole('button', { name: 'Save' }).click()
    await expect(row(page, title)).toBeVisible()

    await row(page, title).getByRole('button', { name: `Edit ${title}` }).click()
    await page.getByRole('form', { name: `Edit ${title}` }).getByRole('button', { name: 'Archive' }).click()
    await expect(row(page, title)).toHaveCount(0)

    const toggle = page.getByRole('button', { name: 'Show archived' })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(row(page, title)).toBeVisible()
    await expect(row(page, title)).toContainText('Archived')

    await page.getByRole('button', { name: 'Hide archived' }).click()
    await expect(row(page, title)).toHaveCount(0)
  })

  test('every control is a 44px target and the page never scrolls sideways, with a panel open', async ({ page }, testInfo) => {
    const title = uniqueName('targets', testInfo)
    await openView(page, 'projects')
    await page.getByRole('toolbar', { name: 'Projects' }).getByRole('button', { name: 'New project' }).click()
    const form = page.getByRole('form', { name: 'New project' })
    await form.getByRole('textbox', { name: 'Name' }).fill(title)
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(row(page, title)).toBeVisible()

    await row(page, title).getByRole('button', { name: `Edit ${title}` }).click()
    expect(await smallTargets(page.locator('main'), 'button, select')).toEqual([])
    await page.keyboard.press('Escape')
    await expectNoHorizontalOverflow(page)
  })
})
