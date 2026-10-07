import { test, expect } from './fixtures.js'
import { TOKEN } from './global-setup.js'
import { openView, expectNoHorizontalOverflow, smallTargets } from './support.js'

const auth = { Authorization: `Bearer ${TOKEN}` }

test.describe('Import tasks', { tag: ['@flow'] }, () => {
  test('pasted lines preview with their subtasks, then import in one go', async ({ page, request }, testInfo) => {
    // Desktop and phone share one server, so each run imports titles of its own.
    const tag = `${testInfo.project.name}-${Date.now()}`
    await openView(page, 'settings')
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Import tasks' }).click()
    const card = page.getByRole('region', { name: 'Import tasks' })
    await expect(card).toBeInViewport()

    await card.getByLabel('Tasks to import').fill(`- Plan trip ${tag}\n  - [ ] Book train ${tag}\n- [x] Renew passport ${tag}`)
    await expect(card.getByRole('button', { name: 'Import', exact: true })).toBeDisabled()
    await card.getByRole('button', { name: 'Preview' }).click()

    const preview = card.getByRole('list', { name: 'Tasks to create' })
    await expect(preview.getByRole('listitem')).toHaveCount(3)
    await expect(preview).toContainText(`Book train ${tag}`)
    await expectNoHorizontalOverflow(page)
    expect(await smallTargets(card)).toEqual([])

    await card.getByRole('button', { name: 'Import 3 tasks' }).click()
    await expect(card.getByRole('status')).toHaveText('Imported 3 tasks.')

    const res = await request.get(`/api/tasks?text=${encodeURIComponent(tag)}&status=open,done&limit=10`, { headers: auth })
    const { tasks } = await res.json()
    const byTitle = Object.fromEntries(tasks.map((t) => [t.title, t]))
    expect(byTitle[`Book train ${tag}`].parentId).toBe(byTitle[`Plan trip ${tag}`].id)
    expect(byTitle[`Renew passport ${tag}`].status).toBe('done')
  })

  test('a CSV with a bad value lists the line and imports nothing', async ({ page, request }, testInfo) => {
    const tag = `${testInfo.project.name}-${Date.now()}`
    await openView(page, 'settings')
    const card = page.getByRole('region', { name: 'Import tasks' })
    await card.getByLabel('Tasks to import').fill(`title,priority,due\nWater plants ${tag},high,2026-11-01\nFix gate ${tag},soonish,`)
    await card.getByRole('button', { name: 'Preview' }).click()

    await expect(card.getByRole('list', { name: 'Problems' })).toContainText('Line 3')
    await expect(card.getByRole('button', { name: /^Import/ })).toBeDisabled()
    const res = await request.get(`/api/tasks?text=${encodeURIComponent(tag)}`, { headers: auth })
    expect((await res.json()).tasks).toEqual([])
  })
})
