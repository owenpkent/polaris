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

// The owner's judgement (docs/agent-threads-proposal.md, stage 2): verdicts on claims, a pinned
// summary, closing and reopening, forking to a subtask, and the Threads page.
test.describe('Threads: the owner judges', { tag: ['@flow'] }, () => {
  test('Accept marks a claim accepted and Mark open takes it back', async ({ page, request }, testInfo) => {
    const { title } = await seedThread(request, testInfo, 'accept', [{ type: 'claim', body: 'A claim to judge.' }])
    await openView(page)
    await openTask(page, title)
    const thread = page.getByRole('dialog', { name: 'Task details' }).getByRole('region', { name: 'Thread' })
    const claim = thread.getByRole('list', { name: 'Posts' }).getByRole('listitem').first()

    await expect(claim.getByText('Open', { exact: true })).toBeVisible()
    await claim.getByRole('button', { name: 'Accept' }).click()
    await expect(claim.getByText('Accepted')).toBeVisible()
    await expect(claim.getByRole('button', { name: 'Accept' })).toHaveCount(0)
    await claim.getByRole('button', { name: 'Mark open' }).click()
    await expect(claim.getByText('Open', { exact: true })).toBeVisible()
    expect(await smallTargets(thread)).toEqual([])
  })

  test('Pin shows the post as the pinned state and Unpin clears it', async ({ page, request }, testInfo) => {
    const { title } = await seedThread(request, testInfo, 'pin', [
      { type: 'claim', body: 'A claim.' },
      { type: 'summary', body: 'Where we are.' },
    ])
    await openView(page)
    await openTask(page, title)
    const thread = page.getByRole('dialog', { name: 'Task details' }).getByRole('region', { name: 'Thread' })

    await thread.getByRole('list', { name: 'Posts' }).getByRole('listitem').nth(1).getByRole('button', { name: 'Pin' }).click()
    const pinned = thread.getByRole('region', { name: 'Pinned state' })
    await expect(pinned).toBeVisible()
    await expect(pinned.getByText('Where we are.')).toBeVisible()
    await pinned.getByRole('button', { name: 'Unpin' }).click()
    await expect(pinned).toHaveCount(0)
  })

  test('Close thread takes the form away and Reopen thread brings it back', async ({ page, request }, testInfo) => {
    const { title } = await seedThread(request, testInfo, 'close', [{ type: 'question', body: 'Open question.' }])
    await openView(page)
    await openTask(page, title)
    const thread = page.getByRole('dialog', { name: 'Task details' }).getByRole('region', { name: 'Thread' })

    await thread.getByRole('button', { name: 'Close thread' }).click()
    await expect(thread.getByText(/^Closed/)).toBeVisible()
    await expect(thread.getByRole('textbox', { name: 'New post' })).toHaveCount(0)
    await thread.getByRole('button', { name: 'Reopen thread' }).click()
    await expect(thread.getByRole('textbox', { name: 'New post' })).toBeVisible()
  })

  test('Fork closes the thread and the successor opens on its own subtask', async ({ page, request }, testInfo) => {
    const { title } = await seedThread(request, testInfo, 'fork', [{ type: 'claim', body: 'Two roads.' }])
    await openView(page)
    await openTask(page, title)
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    const thread = dialog.getByRole('region', { name: 'Thread' })

    await thread.getByRole('button', { name: 'Fork' }).click()
    const titleBox = thread.getByRole('textbox', { name: 'Title of the new thread' })
    await titleBox.fill('The second road')
    // Esc on the form cancels the form, not the panel.
    await page.keyboard.press('Escape')
    await expect(titleBox).toHaveCount(0)
    await expect(dialog).toBeVisible()

    await thread.getByRole('button', { name: 'Fork' }).click()
    await thread.getByRole('textbox', { name: 'Title of the new thread' }).fill('The second road')
    await thread.getByRole('button', { name: 'Fork thread' }).click()
    await expect(thread.getByText(/^Closed/)).toBeVisible()
    await thread.getByRole('button', { name: 'Open the successor thread' }).click()
    await expect(dialog.getByRole('textbox', { name: 'Task title' })).toHaveValue('The second road')
    await expect(dialog.getByRole('region', { name: 'Thread' }).getByRole('textbox', { name: 'New post' })).toBeVisible()
  })

  test('the Threads page lists a thread with its figures and opens its task', async ({ page, request }, testInfo) => {
    const { title } = await seedThread(request, testInfo, 'page', [
      { type: 'claim', body: 'Claim one.' },
      { type: 'claim', body: 'Claim two.' },
      { type: 'objection', body: 'Nobody answered this.' },
      { type: 'result', body: 'A result.' },
    ], { judge: { postIndex: 3, status: 'accepted' } })
    await openView(page, 'threads')
    const card = page.getByRole('article', { name: title })
    await expect(card).toBeVisible()
    await expect(card.getByText('Open claims').locator('..')).toContainText('2')
    await expect(card.getByText('Unanswered objections').locator('..')).toContainText('1')
    await expect(card.getByText('Accepted results').locator('..')).toContainText('1')
    await expect(card.getByText('Days since progress').locator('..')).toContainText('0')
    expect(await smallTargets(card)).toEqual([])

    await card.getByRole('button', { name: `Open ${title}` }).click()
    const dialog = page.getByRole('dialog', { name: 'Task details' })
    await expect(dialog.getByRole('textbox', { name: 'Task title' })).toHaveValue(title)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})
