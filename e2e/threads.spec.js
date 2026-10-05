import { test, expect } from './fixtures.js'
import { createTask, openTask, openView, seedThread, smallTargets } from './support.js'

// A task's thread (docs/agent-threads-proposal.md, stage 1): the owner starts one from the task
// panel, posts typed entries, and filters to the objections. Every test makes its own task.

test.describe('Threads', { tag: ['@flow'] }, () => {
  test('the owner starts a thread, posts a claim and an objection, and filters to objections', async ({ page, request }, testInfo) => {
    const title = await createTask(request, testInfo, 'thread')
    await openView(page)
    await openTask(page, title)
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    const thread = dialog.getByRole('region', { name: 'Thread' })

    await expect(thread.getByText(/No thread yet/)).toBeVisible()
    await thread.getByRole('button', { name: 'Start a thread' }).click()
    await expect(thread.getByText('No posts yet.')).toBeVisible()

    await thread.getByRole('combobox', { name: 'Post type' }).selectOption('claim')
    await thread.getByRole('textbox', { name: 'New post' }).fill('The frontier is empty because every ticket is a discuss ticket.')
    await thread.getByRole('button', { name: 'Post' }).click()
    const posts = thread.getByRole('list', { name: 'Posts' })
    await expect(posts.getByRole('listitem')).toHaveCount(1)
    await expect(posts.getByText('Claim')).toBeVisible()
    await expect(thread.getByRole('textbox', { name: 'New post' })).toHaveValue('')

    await thread.getByRole('combobox', { name: 'Post type' }).selectOption('objection')
    await thread.getByRole('textbox', { name: 'New post' }).fill('Two of them are research tickets with no assignee.')
    await thread.getByRole('button', { name: 'Post' }).click()
    await expect(posts.getByRole('listitem')).toHaveCount(2)

    const toggle = thread.getByRole('button', { name: 'Objections only (1)' })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(posts.getByRole('listitem')).toHaveCount(1)
    await expect(posts.getByText('Objection')).toBeVisible()
    await toggle.click()
    await expect(posts.getByRole('listitem')).toHaveCount(2)
  })

  test('a seeded thread shows its posts with author and type, and its controls are 44px', async ({ page, request }, testInfo) => {
    const { title } = await seedThread(request, testInfo, 'seeded', [
      { type: 'claim', body: 'Seeded claim.', confidence: 'high' },
      { type: 'evidence', body: 'Seeded evidence.' },
    ])
    await openView(page)
    await openTask(page, title)
    const thread = page.getByRole('dialog', { name: 'Task details' }).getByRole('region', { name: 'Thread' })
    const items = thread.getByRole('list', { name: 'Posts' }).getByRole('listitem')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText('Claim')
    await expect(items.nth(0)).toContainText('You')
    await expect(items.nth(0)).toContainText('High confidence')
    await expect(items.nth(1)).toContainText('Evidence')
    expect(await smallTargets(thread)).toEqual([])
  })

  test('Esc still closes the panel from the post box', async ({ page, request }, testInfo) => {
    const { title } = await seedThread(request, testInfo, 'esc', [{ type: 'question', body: 'Which norm?' }])
    await openView(page)
    await openTask(page, title)
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    await dialog.getByRole('region', { name: 'Thread' }).getByRole('textbox', { name: 'New post' }).focus()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})
