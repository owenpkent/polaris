import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import UpdateButton from './UpdateButton'
import { markOffline, resetOfflineStatus } from './command-center/offlineStatus'

const connection = { connected: true, api: { getUpdate: vi.fn(), requestUpdate: vi.fn(), cancelUpdateRequest: vi.fn() } }
vi.mock('./command-center/ConnectionContext', () => ({ useConnection: () => connection }))

const COMMAND = 'npm run cc -- update --release'
const AVAILABLE = { version: '2.1.0', notes: 'Fixes the digest footer.\n\nAdds the update icon.', touchesSchema: false }
const IDLE = { running: '2.0.0', updaterInstalled: true, available: AVAILABLE, request: null, lastResult: null, command: COMMAND }
// After the update went in: nothing newer is named, and the status file carries the result.
const UPDATED = { ...IDLE, running: '2.1.0', available: null, lastResult: { ok: true, message: 'Updated to v2.1.0', at: '2026-10-06T04:05:00.000Z', version: '2.1.0' } }

function serve(update) {
  connection.api.getUpdate.mockResolvedValue(update)
}

async function openPanel() {
  render(<UpdateButton />)
  const icon = await screen.findByRole('button', { name: 'Update available' })
  fireEvent.click(icon)
  return { icon, dialog: screen.getByRole('dialog', { name: 'Update available' }) }
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* jsdom without storage */ }
})

afterEach(() => {
  cleanup()
  resetOfflineStatus()
  connection.connected = true
  connection.api.getUpdate.mockReset()
  connection.api.requestUpdate.mockReset()
  connection.api.cancelUpdateRequest.mockReset()
})

describe('the update icon', () => {
  test('is absent until the server names a newer release, then present as a 44px labelled button', async () => {
    serve({ ...IDLE, available: null })
    render(<UpdateButton />)
    await waitFor(() => expect(connection.api.getUpdate).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Update available' })).toBeNull()
    cleanup()

    serve(IDLE)
    render(<UpdateButton />)
    const icon = await screen.findByRole('button', { name: 'Update available' })
    expect(icon.className).toContain('icon-btn')
    expect(icon.getAttribute('aria-haspopup')).toBe('dialog')
    expect(icon.getAttribute('aria-expanded')).toBe('false')
  })

  test('is absent offline and when disconnected, whatever the server last said', async () => {
    serve(IDLE)
    markOffline()
    render(<UpdateButton />)
    expect(connection.api.getUpdate).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Update available' })).toBeNull()
    cleanup()
    resetOfflineStatus()
    connection.connected = false
    render(<UpdateButton />)
    expect(screen.queryByRole('button', { name: 'Update available' })).toBeNull()
  })

  test('opens a labelled dialog with both versions and the notes kept as written, closes on Esc, and returns focus', async () => {
    serve(IDLE)
    const { icon, dialog } = await openPanel()
    expect(icon.getAttribute('aria-expanded')).toBe('true')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.textContent).toContain('2.0.0')
    expect(dialog.textContent).toContain('2.1.0')
    const notes = screen.getByRole('region', { name: 'Release notes' })
    expect(notes.textContent).toContain('Fixes the digest footer.\n\nAdds the update icon.')
    expect(notes.querySelector('a, strong, em, h1, h2, h3')).toBeNull()
    expect(dialog.textContent).not.toContain('snapshot')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close update panel' })))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(icon)
  })

  test('says a snapshot is taken first when the update changes the database', async () => {
    serve({ ...IDLE, available: { ...AVAILABLE, touchesSchema: true } })
    const { dialog } = await openPanel()
    expect(dialog.textContent).toContain('This update changes the database; a snapshot is taken first.')
  })
})

describe('after an update went in', () => {
  test('the icon shows once with the result, the panel says only what happened, and Dismiss hides the icon for good', async () => {
    serve(UPDATED)
    render(<UpdateButton />)
    const icon = await screen.findByRole('button', { name: 'Update installed' })
    expect(icon.className).toContain('icon-btn')
    expect(screen.queryByRole('button', { name: 'Update available' })).toBeNull()
    fireEvent.click(icon)
    const dialog = screen.getByRole('dialog', { name: 'Update installed' })
    expect(screen.getByRole('status').textContent).toBe('Updated to v2.1.0')
    expect(screen.queryByRole('region', { name: 'Release notes' })).toBeNull()
    expect(dialog.textContent).not.toContain('Running')
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(Array.from(dialog.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') || b.textContent)).toEqual(['Close update panel', 'Dismiss'])
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close update panel' })))

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update installed' })).toBeNull()
    expect(JSON.parse(localStorage.getItem('cc.update.seenResult'))).toEqual([UPDATED.lastResult.at])

    // A fresh mount reads the memory: the same result stays dismissed.
    cleanup()
    render(<UpdateButton />)
    await waitFor(() => expect(connection.api.getUpdate).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button', { name: 'Update installed' })).toBeNull()
  })

  test('a later result shows again, and Esc closes the panel', async () => {
    localStorage.setItem('cc.update.seenResult', JSON.stringify([UPDATED.lastResult.at]))
    serve({ ...UPDATED, lastResult: { ...UPDATED.lastResult, at: '2026-10-07T04:05:00.000Z', message: 'Updated to v2.2.0', version: '2.2.0' } })
    render(<UpdateButton />)
    const icon = await screen.findByRole('button', { name: 'Update installed' })
    fireEvent.click(icon)
    expect(screen.getByRole('status').textContent).toBe('Updated to v2.2.0')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(icon)
  })

  test('a failed last result shows no icon: the red strip carries it, and the version is used when the message is empty', async () => {
    serve({ ...UPDATED, lastResult: { ...UPDATED.lastResult, ok: false, message: 'Rolled back: the build failed' } })
    render(<UpdateButton />)
    await waitFor(() => expect(connection.api.getUpdate).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /Update/ })).toBeNull()
    cleanup()

    serve({ ...UPDATED, lastResult: { ...UPDATED.lastResult, message: '' } })
    render(<UpdateButton />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update installed' }))
    expect(screen.getByRole('status').textContent).toBe('Updated to v2.1.0')
  })

  test('a newer release named at the same time wins: the available panel, with the result as its finished state', async () => {
    serve({ ...IDLE, lastResult: UPDATED.lastResult })
    const { dialog } = await openPanel()
    expect(dialog.textContent).toContain('2.1.0')
    expect(screen.getByRole('region', { name: 'Release notes' })).not.toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Updated to v2.1.0')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.getByRole('button', { name: 'Update now' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Update available' })).not.toBeNull()
  })

  test('an id kept by the earlier single-string memory still counts as seen', async () => {
    localStorage.setItem('cc.update.seenResult', UPDATED.lastResult.at)
    serve(UPDATED)
    render(<UpdateButton />)
    await waitFor(() => expect(connection.api.getUpdate).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Update installed' })).toBeNull()
  })
})

describe('the update panel', () => {
  test('Update now asks the server for the exact version shown, and the panel turns to the pending state', async () => {
    serve(IDLE)
    connection.api.requestUpdate.mockResolvedValue({ request: { id: 'up_1', version: '2.1.0', state: 'pending' } })
    const { dialog } = await openPanel()
    const button = screen.getByRole('button', { name: 'Update now' })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(connection.api.requestUpdate).toHaveBeenCalledWith('2.1.0'))
    await screen.findByText('Requested. The updater picks it up within five minutes.')
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull()
    expect(dialog.textContent).not.toContain(COMMAND)
  })

  test('Update now is disabled offline', async () => {
    serve(IDLE)
    await openPanel()
    expect(screen.getByRole('button', { name: 'Update now' }).disabled).toBe(false)
    markOffline()
    // The hook hides the icon offline; the panel's own control follows useOffline too.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Update available' })).toBeNull())
  })

  test('a refusal from the server is shown in the panel', async () => {
    serve(IDLE)
    connection.api.requestUpdate.mockRejectedValue(new Error('an update request is already pending'))
    await openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('an update request is already pending')
    expect(screen.getByRole('button', { name: 'Update now' }).disabled).toBe(false)
  })

  test('the pending state offers Cancel request, which goes to the server', async () => {
    serve({ ...IDLE, request: { id: 'up_1', version: '2.1.0', state: 'pending' } })
    connection.api.cancelUpdateRequest.mockResolvedValue({ request: { id: 'up_1', version: '2.1.0', state: 'cancelled' } })
    await openPanel()
    expect(screen.getByRole('status').textContent).toBe('Requested. The updater picks it up within five minutes.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }))
    await waitFor(() => expect(connection.api.cancelUpdateRequest).toHaveBeenCalledWith('up_1'))
    await screen.findByRole('button', { name: 'Update now' })
  })

  test('the picked-up state says Updating and offers nothing to press', async () => {
    serve({ ...IDLE, request: { id: 'up_1', version: '2.1.0', state: 'picked_up' } })
    const { dialog } = await openPanel()
    expect(screen.getByRole('status').textContent).toContain('Updating')
    expect(dialog.querySelectorAll('button').length).toBe(1)
    expect(screen.getByRole('button', { name: 'Close update panel' })).not.toBeNull()
  })

  test('a finished request shows its result once: Dismiss hides it and brings Update now back', async () => {
    serve({ ...IDLE, request: { id: 'up_1', version: '2.1.0', state: 'failed', result: 'Rolled back: the build failed' } })
    await openPanel()
    expect(screen.getByRole('status').textContent).toBe('Rolled back: the build failed')
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Update now' })).not.toBeNull()

    // Opened again, the result stays dismissed.
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Update available' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Update now' })).not.toBeNull()
  })

  test('without the scheduled updater there is no button, only the command to copy', async () => {
    serve({ ...IDLE, updaterInstalled: false })
    const { dialog } = await openPanel()
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull()
    expect(screen.getByRole('textbox').value).toBe(COMMAND)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(COMMAND))
    await screen.findByRole('button', { name: 'Copied' })
    expect(dialog.textContent).toContain('No scheduled updater is installed on the server.')
  })

  test('a request that finished while the daemon slept shows the status file result, once', async () => {
    // The daemon reconciles a picked-up row from the status file, so the request is done and the
    // result is there too: one run, one Dismiss, and nothing comes back after it.
    serve({ ...IDLE, request: { id: 'up_1', version: '2.1.0', state: 'done', result: 'Updated to v2.1.0' }, lastResult: UPDATED.lastResult })
    await openPanel()
    expect(screen.getByRole('status').textContent).toBe('Updated to v2.1.0')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Update now' })).not.toBeNull()
    expect(JSON.parse(localStorage.getItem('cc.update.seenResult'))).toEqual(['up_1', UPDATED.lastResult.at])
  })

  test('the controls are 44px targets', async () => {
    serve(IDLE)
    const { icon } = await openPanel()
    expect(icon.className).toContain('icon-btn')
    expect(screen.getByRole('button', { name: 'Close update panel' }).className).toContain('icon-btn')
    expect(screen.getByRole('button', { name: 'Update now' }).className).toContain('btn')
  })
})
