import { test, expect } from './fixtures.js'
import { MIN_TARGET, UPDATE_AVAILABLE, UPDATE_INSTALLED, expectFocusRing, fakeUpdate, openView, smallTargets } from './support.js'

// The update icon and its panel (docs/update-proposal.md, section 4B). The test server has no
// updater and no status file, so the icon is absent until GET /api/update is routed to say a
// newer signed release exists (fakeUpdate in support.js). Pressing Update now records a request
// on the server; nothing here installs anything.

const icon = (page) => page.getByRole('button', { name: 'Update available' })
const panel = (page) => page.getByRole('dialog', { name: 'Update available' })

test.describe('update icon', { tag: ['@flow'] }, () => {
  test('is absent while the server names no newer release', async ({ page }) => {
    await openView(page)
    await expect(page.getByRole('button', { name: 'Theme' })).toBeVisible()
    await expect(icon(page)).toHaveCount(0)
  })

  test('shows the versions, the notes as written, and the snapshot line, and asks for exactly the version shown', async ({ page }) => {
    await fakeUpdate(page)
    const requested = []
    await page.route((url) => url.pathname === '/api/update/requests', async (route) => {
      requested.push(route.request().postDataJSON())
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ request: { id: 'up_test', version: '2.1.0', state: 'pending' } }) })
    })
    await openView(page)
    await icon(page).click()
    const dialog = panel(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('2.0.0')).toBeVisible()
    await expect(dialog.getByText('2.1.0')).toBeVisible()
    await expect(dialog.getByRole('region', { name: 'Release notes' })).toContainText('The digest footer no longer repeats the date.')
    await expect(dialog.getByText('This update changes the database; a snapshot is taken first.')).toBeVisible()
    expect(await smallTargets(dialog)).toEqual([])

    await dialog.getByRole('button', { name: 'Update now' }).click()
    await expect(dialog.getByRole('status')).toHaveText('Requested. The updater picks it up within five minutes.')
    await expect(dialog.getByRole('button', { name: 'Cancel request' })).toBeVisible()
    expect(requested).toEqual([{ version: '2.1.0' }])
  })

  test('without the scheduled updater there is no button, only the command to copy', async ({ page }) => {
    await fakeUpdate(page, { ...UPDATE_AVAILABLE, updaterInstalled: false })
    await openView(page)
    await icon(page).click()
    const dialog = panel(page)
    await expect(dialog.getByRole('button', { name: 'Update now' })).toHaveCount(0)
    await expect(dialog.getByRole('textbox')).toHaveValue('npm run cc -- update --release')
    await expect(dialog.getByRole('button', { name: 'Copy' })).toBeVisible()
  })

  test('after the update went in, the icon shows the result once: the panel says only what happened, and Dismiss hides it for good', async ({ page }) => {
    await fakeUpdate(page, UPDATE_INSTALLED)
    await openView(page)
    const button = page.getByRole('button', { name: 'Update installed' })
    await expect(button).toBeVisible()
    await expect(icon(page)).toHaveCount(0)
    await button.click()
    const dialog = page.getByRole('dialog', { name: 'Update installed' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('status')).toHaveText('Updated to v2.1.0')
    await expect(dialog.getByRole('region', { name: 'Release notes' })).toHaveCount(0)
    await expect(dialog.getByRole('button')).toHaveCount(2)
    await expect(dialog.getByRole('button', { name: 'Close update panel' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Update now' })).toHaveCount(0)
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
    expect(await smallTargets(dialog)).toEqual([])

    await dialog.getByRole('button', { name: 'Dismiss' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(button).toHaveCount(0)

    // The memory is per device: a reload with the same answer shows nothing.
    await page.reload()
    await expect(page.getByRole('button', { name: 'Theme' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Update installed' })).toHaveCount(0)
  })
})

test.describe('update panel keyboard', { tag: ['@a11y', '@theme'] }, () => {
  test('the icon is a 44px target with a focus ring, Esc closes the panel, and focus returns to the icon', async ({ page }) => {
    await fakeUpdate(page)
    await openView(page)
    const button = icon(page)
    await expect(button).toBeVisible()
    const box = await button.boundingBox()
    expect(box.width).toBeGreaterThanOrEqual(MIN_TARGET)
    expect(box.height).toBeGreaterThanOrEqual(MIN_TARGET)
    await button.focus()
    await expectFocusRing(page)

    await page.keyboard.press('Enter')
    const dialog = panel(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Close update panel' })).toBeFocused()
    await expectFocusRing(page)
    expect(await smallTargets(dialog)).toEqual([])

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(button).toBeFocused()
    await expect(button).toHaveAttribute('aria-expanded', 'false')
  })
})
