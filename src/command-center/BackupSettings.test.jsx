import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import BackupSettings, { makePassphrase } from './BackupSettings'
import { markOffline, resetOfflineStatus } from './offlineStatus'

const api = {
  getBackup: vi.fn(),
  setBackupEncryption: vi.fn(),
  disableBackupEncryption: vi.fn(),
  checkBackup: vi.fn(),
  runSync: vi.fn(),
}
const connection = { connected: true, api }
vi.mock('./ConnectionContext', () => ({ useConnection: () => connection }))

const job = { lastRunAt: '2026-09-21T03:15:00Z', lastError: null, running: false }
const OFF = {
  encryption: false, folder: '\\\\nas\\backups', keep: 14, copies: 1, plainCopies: 1, minPassphraseLength: 12, job,
  newest: { name: 'constellation-2026-09-21.db', encrypted: false, bytes: 417792, modifiedAt: '2026-09-21T03:15:00Z' },
}
const ON = { ...OFF, encryption: true, plainCopies: 0, newest: { ...OFF.newest, name: 'constellation-2026-09-21.db.enc', encrypted: true } }

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  connection.connected = true
})

afterEach(() => {
  cleanup()
  resetOfflineStatus()
})

const button = (name) => screen.getByRole('button', { name })

describe('makePassphrase', () => {
  test('is six groups of four URL-safe characters, and differs each time', () => {
    const a = makePassphrase()
    expect(a).toMatch(/^([A-Za-z0-9_-]{4}-){5}[A-Za-z0-9_-]{4}$/)
    expect(makePassphrase()).not.toBe(a)
  })

  test('uses every byte it is given', () => {
    const zeros = makePassphrase((bytes) => bytes.fill(0))
    const ones = makePassphrase((bytes) => bytes.fill(255))
    expect(zeros).toBe('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA')
    expect(ones).toBe('____-____-____-____-____-____')
  })
})

describe('BackupSettings', () => {
  test('shows the state of backups: encryption, folder, newest copy, copies kept', async () => {
    api.getBackup.mockResolvedValue(OFF)
    render(<BackupSettings />)
    const card = await screen.findByRole('region', { name: 'Backups' })
    expect(card.textContent).toContain('Off')
    expect(card.textContent).toContain('\\\\nas\\backups')
    expect(card.textContent).toContain('constellation-2026-09-21.db')
    expect(card.textContent).toContain('408 KB')
    expect(card.textContent).toContain('1 of 14')
    expect(button(/Turn on encryption/)).toBeTruthy()
  })

  test('shows nothing when not connected', () => {
    connection.connected = false
    const { container } = render(<BackupSettings />)
    expect(container.textContent).toBe('')
    expect(api.getBackup).not.toHaveBeenCalled()
  })

  test('turning on with a made passphrase: it is shown, and nothing can be sent until it is confirmed saved', async () => {
    api.getBackup.mockResolvedValue(OFF)
    api.setBackupEncryption.mockResolvedValue(ON)
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Turn on encryption/ }))

    const form = screen.getByRole('form', { name: 'Turn on backup encryption' })
    const made = within(form).getByLabelText('Your passphrase').value
    expect(made).toMatch(/^([A-Za-z0-9_-]{4}-){5}[A-Za-z0-9_-]{4}$/)
    const submit = within(form).getByRole('button', { name: 'Turn on encryption' })
    expect(submit.disabled).toBe(true)

    fireEvent.click(within(form).getByLabelText('I have saved this passphrase in my password manager'))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)

    await waitFor(() => expect(api.setBackupEncryption).toHaveBeenCalledWith(made, false))
    await screen.findByText(/Encryption is on/)
    expect(screen.queryByRole('form')).toBeNull()
    expect(document.body.textContent).not.toContain(made)
    expect(button('Change passphrase')).toBeTruthy()
  })

  test('Make another gives a new passphrase and asks for the saved tick again', async () => {
    api.getBackup.mockResolvedValue(OFF)
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Turn on encryption/ }))
    const first = screen.getByLabelText('Your passphrase').value
    const saved = screen.getByLabelText('I have saved this passphrase in my password manager')
    fireEvent.click(saved)
    fireEvent.click(button('Make another'))
    expect(screen.getByLabelText('Your passphrase').value).not.toBe(first)
    expect(saved.checked).toBe(false)
  })

  test('a typed passphrase must be long enough and match, and is hidden unless shown', async () => {
    api.getBackup.mockResolvedValue(OFF)
    api.setBackupEncryption.mockResolvedValue(ON)
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Turn on encryption/ }))
    fireEvent.click(screen.getByLabelText('I will type my own'))

    const first = screen.getByLabelText(/^Passphrase \(12 or more/)
    const again = screen.getByLabelText('The same passphrase again')
    expect(first.type).toBe('password')
    fireEvent.click(screen.getByLabelText('I have saved this passphrase in my password manager'))
    const submit = screen.getByRole('button', { name: 'Turn on encryption' })

    fireEvent.change(first, { target: { value: 'too short' } })
    expect(screen.getByRole('alert').textContent).toContain('12 or more')
    expect(submit.disabled).toBe(true)

    // Twelve spaces are not a passphrase, whatever their length.
    fireEvent.change(first, { target: { value: '            ' } })
    expect(screen.getByRole('alert').textContent).toContain('not counting spaces')
    fireEvent.click(screen.getByLabelText('I have saved this passphrase in my password manager'))

    fireEvent.change(first, { target: { value: 'a long enough passphrase' } })
    fireEvent.change(again, { target: { value: 'a long enough passphrasf' } })
    expect(screen.getByRole('alert').textContent).toContain('do not match')
    expect(submit.disabled).toBe(true)

    fireEvent.change(again, { target: { value: 'a long enough passphrase' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByLabelText('I have saved this passphrase in my password manager'))
    fireEvent.click(screen.getByLabelText('Show what I type'))
    expect(first.type).toBe('text')
    fireEvent.click(submit)
    await waitFor(() => expect(api.setBackupEncryption).toHaveBeenCalledWith('a long enough passphrase', false))
  })

  test('Esc closes the form without sending anything, and focus goes back to the button that opened it', async () => {
    api.getBackup.mockResolvedValue(OFF)
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Turn on encryption/ }))
    fireEvent.keyDown(screen.getByRole('form'), { key: 'Escape' })
    expect(screen.queryByRole('form')).toBeNull()
    expect(api.setBackupEncryption).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(button(/Turn on encryption/)))
  })

  test('changing the passphrase sends replace, and warns that older backups need the old one', async () => {
    api.getBackup.mockResolvedValue(ON)
    api.setBackupEncryption.mockResolvedValue(ON)
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Change passphrase' }))
    const form = screen.getByRole('form', { name: 'Change the backup passphrase' })
    expect(form.textContent).toContain('still need the old passphrase')
    const made = within(form).getByLabelText('Your passphrase').value
    fireEvent.click(within(form).getByLabelText('I have saved this passphrase in my password manager'))
    fireEvent.click(within(form).getByRole('button', { name: 'Change passphrase' }))
    await waitFor(() => expect(api.setBackupEncryption).toHaveBeenCalledWith(made, true))
  })

  test('turning off asks first, and says what it means', async () => {
    api.getBackup.mockResolvedValue(ON)
    api.disableBackupEncryption.mockResolvedValue(OFF)
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off encryption' }))
    expect(api.disableBackupEncryption).not.toHaveBeenCalled()
    fireEvent.click(button('Make new backups readable?'))
    await waitFor(() => expect(api.disableBackupEncryption).toHaveBeenCalled())
    await screen.findByText(/still need their passphrase/)
  })

  test('readable copies left over after turning encryption on are pointed out', async () => {
    api.getBackup.mockResolvedValue({ ...ON, plainCopies: 3 })
    render(<BackupSettings />)
    await screen.findByText(/3 readable copies are still in the folder/)
  })

  test('Check newest backup reports a good copy and a bad one', async () => {
    api.getBackup.mockResolvedValue(ON)
    api.checkBackup.mockResolvedValueOnce({ checked: true, ok: true, name: 'constellation-2026-09-21.db.enc', encrypted: true, problems: [], counts: { tasks: 141, projects: 8, events: 292 } })
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Check newest backup/ }))
    await screen.findByText('This backup can be restored.')
    expect(document.body.textContent).toContain('141 tasks, 8 projects')

    api.checkBackup.mockResolvedValueOnce({ checked: true, ok: false, name: 'x.db.enc', encrypted: true, problems: ['made under another passphrase'] })
    fireEvent.click(button(/Check newest backup/))
    await screen.findByText('This backup should not be trusted.')
    expect(document.body.textContent).toContain('made under another passphrase')
  })

  test('Back up now starts the backup job and reads the state again', async () => {
    api.getBackup.mockResolvedValue(OFF)
    api.runSync.mockResolvedValue({ started: true })
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Back up now/ }))
    await waitFor(() => expect(api.runSync).toHaveBeenCalledWith('backup'))
    await waitFor(() => expect(api.getBackup).toHaveBeenCalledTimes(2))
  })

  test('a server with no jobs says so and offers no Back up now', async () => {
    api.getBackup.mockResolvedValue({ ...OFF, job: null })
    render(<BackupSettings />)
    await screen.findByText(/runs no jobs/)
    expect(screen.queryByRole('button', { name: /Back up now/ })).toBeNull()
  })

  test('offline: every control that writes is off, and it says why', async () => {
    api.getBackup.mockResolvedValue(ON)
    markOffline()
    render(<BackupSettings />)
    await screen.findByText(/Backup settings can be changed when the server is back/)
    for (const name of [/Back up now/, /Check newest backup/, 'Change passphrase', 'Turn off encryption']) {
      expect(button(name).disabled).toBe(true)
    }
  })

  test('a refused request shows the server message and keeps the form open', async () => {
    api.getBackup.mockResolvedValue(OFF)
    api.setBackupEncryption.mockRejectedValue(new Error('Backup encryption is already on.'))
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Turn on encryption/ }))
    fireEvent.click(screen.getByLabelText('I have saved this passphrase in my password manager'))
    fireEvent.click(screen.getByRole('button', { name: 'Turn on encryption' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('already on')
    expect(screen.getByRole('form')).toBeTruthy()
  })
})


describe('BackupSettings safeguards', () => {
  test('changing a typed passphrase after ticking saved needs the tick again, for the new value', async () => {
    api.getBackup.mockResolvedValue(OFF)
    api.setBackupEncryption.mockResolvedValue(ON)
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Turn on encryption/ }))
    fireEvent.click(screen.getByLabelText('I will type my own'))
    const first = screen.getByLabelText(/^Passphrase \(12 or more/)
    const again = screen.getByLabelText('The same passphrase again')
    const saved = screen.getByLabelText('I have saved this passphrase in my password manager')
    const submit = screen.getByRole('button', { name: 'Turn on encryption' })

    fireEvent.change(first, { target: { value: 'passphrase A is saved' } })
    fireEvent.change(again, { target: { value: 'passphrase A is saved' } })
    fireEvent.click(saved)
    expect(submit.disabled).toBe(false)

    fireEvent.change(first, { target: { value: 'passphrase B is not' } })
    fireEvent.change(again, { target: { value: 'passphrase B is not' } })
    expect(saved.checked).toBe(false)
    expect(submit.disabled).toBe(true)
    fireEvent.click(submit)
    expect(api.setBackupEncryption).not.toHaveBeenCalled()

    fireEvent.click(saved)
    fireEvent.click(submit)
    await waitFor(() => expect(api.setBackupEncryption).toHaveBeenCalledWith('passphrase B is not', false))
  })

  test('going offline with the form open disables sending, in both variants, and nothing is sent', async () => {
    for (const [state, name] of [[OFF, /Turn on encryption/], [ON, 'Change passphrase']]) {
      api.getBackup.mockResolvedValue(state)
      render(<BackupSettings />)
      fireEvent.click(await screen.findByRole('button', { name }))
      const form = screen.getByRole('form')
      fireEvent.click(within(form).getByLabelText('I have saved this passphrase in my password manager'))
      const submit = within(form).getByRole('button', { name: state.encryption ? 'Change passphrase' : 'Turn on encryption' })
      expect(submit.disabled).toBe(false)

      act(() => markOffline())
      expect(submit.disabled).toBe(true)
      expect(within(form).getByText('Cannot be sent right now.')).toBeTruthy()
      fireEvent.submit(form)
      expect(api.setBackupEncryption).not.toHaveBeenCalled()

      cleanup()
      resetOfflineStatus()
    }
  })

  test('the form cannot be sent while another card action is busy', async () => {
    api.getBackup.mockResolvedValue(OFF)
    let finishCheck
    api.checkBackup.mockReturnValue(new Promise((resolve) => { finishCheck = resolve }))
    render(<BackupSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Turn on encryption/ }))
    fireEvent.click(screen.getByLabelText('I have saved this passphrase in my password manager'))
    const submit = screen.getByRole('button', { name: 'Turn on encryption' })
    expect(submit.disabled).toBe(false)

    fireEvent.click(button(/Check newest backup/))
    await waitFor(() => expect(submit.disabled).toBe(true))
    finishCheck({ checked: false, message: 'none' })
    await waitFor(() => expect(submit.disabled).toBe(false))
  })
})
