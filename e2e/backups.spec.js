import { test, expect } from './fixtures.js'
import { TOKEN } from './global-setup.js'
import { openView, expectNoHorizontalOverflow, smallTargets } from './support.js'

// The test server has its own secret store and backup folder (CC_SECRETS_DIR and CC_BACKUP_DIR in
// global-setup.js), so setting a passphrase here never touches this machine's real one. Desktop
// and phone share that server, so every test first puts encryption back to off.
const auth = { Authorization: `Bearer ${TOKEN}` }

test.describe('Backup settings', { tag: ['@flow'] }, () => {
  test.beforeEach(async ({ request }) => {
    await request.delete('/api/backup/encryption', { headers: auth })
  })

  test('the card shows the state of backups and fits the page', async ({ page }) => {
    await openView(page, 'connection')
    const card = page.getByRole('region', { name: 'Backups' })
    await expect(card).toContainText('Encryption')
    await expect(card).toContainText('Off')
    // The test server runs `serve`, which has no jobs.
    await expect(card).toContainText('runs no jobs')
    await expect(card.getByRole('button', { name: 'Back up now' })).toHaveCount(0)
    await expectNoHorizontalOverflow(page)
    expect(await smallTargets(card)).toEqual([])
  })

  test('turning encryption on needs the saved tick, then shows On and offers Change and Turn off', async ({ page, request }) => {
    await openView(page, 'connection')
    const card = page.getByRole('region', { name: 'Backups' })
    await card.getByRole('button', { name: 'Turn on encryption' }).click()

    const form = page.getByRole('form', { name: 'Turn on backup encryption' })
    const made = await form.getByLabel('Your passphrase').inputValue()
    expect(made).toMatch(/^([A-Za-z0-9_-]{4}-){5}[A-Za-z0-9_-]{4}$/)
    expect(await smallTargets(form)).toEqual([])
    const submit = form.getByRole('button', { name: 'Turn on encryption' })
    await expect(submit).toBeDisabled()

    await form.getByLabel('I have saved this passphrase in my password manager').check()
    await submit.click()

    // Saving runs powershell.exe for DPAPI on Windows, and on the CI runner the form has still
    // shown "Saving…" when the default 5 seconds ran out.
    await expect(card).toContainText('Encryption is on', { timeout: 20000 })
    await expect(page.getByRole('form')).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Change passphrase' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Turn off encryption' })).toBeVisible()
    await expect(page.getByText(made)).toHaveCount(0)

    const status = await (await request.get('/api/backup', { headers: auth })).json()
    expect(status.encryption).toBe(true)
    expect(JSON.stringify(status)).not.toContain(made)
  })

  test('a typed passphrase that is too short or does not match cannot be sent', async ({ page }) => {
    await openView(page, 'connection')
    await page.getByRole('region', { name: 'Backups' }).getByRole('button', { name: 'Turn on encryption' }).click()
    const form = page.getByRole('form', { name: 'Turn on backup encryption' })
    await form.getByLabel('I will type my own').check()
    const saved = form.getByLabel('I have saved this passphrase in my password manager')
    const submit = form.getByRole('button', { name: 'Turn on encryption' })

    await form.getByLabel(/^Passphrase \(/).fill('too short')
    await expect(form.getByRole('alert')).toContainText('12 or more')
    await expect(submit).toBeDisabled()

    await form.getByLabel(/^Passphrase \(/).fill('a long enough passphrase')
    await form.getByLabel('The same passphrase again').fill('a long enough passphrasf')
    await expect(form.getByRole('alert')).toContainText('do not match')
    await expect(submit).toBeDisabled()

    await form.getByLabel('The same passphrase again').fill('a long enough passphrase')
    await saved.check()
    await expect(submit).toBeEnabled()

    // A changed passphrase is a different passphrase: the tick was for the old one.
    await form.getByLabel(/^Passphrase \(/).fill('another long passphrase')
    await form.getByLabel('The same passphrase again').fill('another long passphrase')
    await expect(saved).not.toBeChecked()
    await expect(submit).toBeDisabled()
  })

  test('Esc closes the form, sends nothing, and focus returns to the button that opened it', async ({ page, request }) => {
    await openView(page, 'connection')
    const open = page.getByRole('region', { name: 'Backups' }).getByRole('button', { name: 'Turn on encryption' })
    await open.click()
    await expect(page.getByRole('form')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('form')).toHaveCount(0)
    await expect(open).toBeFocused()
    const status = await (await request.get('/api/backup', { headers: auth })).json()
    expect(status.encryption).toBe(false)
  })

  test('turning encryption off asks first', async ({ page, request }) => {
    // Checked, so a server that cannot store a secret fails here with its reason, not 30 seconds later on a missing button.
    const set = await request.post('/api/backup/encryption', { headers: auth, data: { passphrase: 'a long enough passphrase' } })
    expect(set.ok(), await set.text()).toBe(true)
    await openView(page, 'connection')
    const card = page.getByRole('region', { name: 'Backups' })
    await card.getByRole('button', { name: 'Turn off encryption' }).click()
    expect((await (await request.get('/api/backup', { headers: auth })).json()).encryption).toBe(true)

    await card.getByRole('button', { name: 'Make new backups readable?' }).click()
    await expect(card).toContainText('Encryption is off')
    await expect(card.getByRole('button', { name: 'Turn on encryption' })).toBeVisible()
  })
})
