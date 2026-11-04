import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AppUpdateSettings from './AppUpdateSettings'

let native = true
let prefs
const getAppInfo = vi.fn()
const runAppUpdateCheck = vi.fn()
const installReadyUpdate = vi.fn()
const saveAppUpdatePrefs = vi.fn()

vi.mock('./nativeApp', () => ({
  isNativeApp: () => native,
  getAppInfo: (...args) => getAppInfo(...args),
}))
vi.mock('./appAutoUpdate', () => ({
  APP_UPDATE_CHANGED_EVENT: 'cc-app-update-changed',
  readAppUpdatePrefs: () => prefs,
  saveAppUpdatePrefs: (...args) => saveAppUpdatePrefs(...args),
  runAppUpdateCheck: (...args) => runAppUpdateCheck(...args),
  installReadyUpdate: (...args) => installReadyUpdate(...args),
}))

const READY = { version: '2.4.0', path: '/cache/updates/polaris-2.4.0.apk', name: 'polaris-2.4.0.apk' }

beforeEach(() => {
  native = true
  prefs = { enabled: true, lastCheckedAt: null, ready: null, lastError: null }
  getAppInfo.mockReset()
  runAppUpdateCheck.mockReset()
  installReadyUpdate.mockReset()
  saveAppUpdatePrefs.mockReset()
  getAppInfo.mockResolvedValue({ version: '2.3.0', build: '20300' })
  runAppUpdateCheck.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
})

describe('AppUpdateSettings', () => {
  test('renders nothing outside the app', () => {
    native = false
    const { container } = render(<AppUpdateSettings />)
    expect(container.innerHTML).toBe('')
  })

  test('shows the running version, or Unknown when it cannot be read', async () => {
    render(<AppUpdateSettings />)
    expect(screen.getByRole('region', { name: 'App update' })).toBeTruthy()
    expect(await screen.findByText('v2.3.0')).toBeTruthy()
    cleanup()
    getAppInfo.mockRejectedValue(new Error('no bridge'))
    render(<AppUpdateSettings />)
    expect(await screen.findByText('Unknown')).toBeTruthy()
  })

  test('the checkbox is on by default and saves the choice', async () => {
    render(<AppUpdateSettings />)
    await screen.findByText('v2.3.0')
    const box = screen.getByRole('checkbox', { name: 'Check for app updates automatically' })
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(saveAppUpdatePrefs).toHaveBeenCalledWith({ ...prefs, enabled: false })
  })

  test('before any check it says never, and offers no install', async () => {
    render(<AppUpdateSettings />)
    await screen.findByText('v2.3.0')
    expect(screen.getByText('Last checked: never')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Install/ })).toBeNull()
    expect(screen.queryByText('You have the newest version.')).toBeNull()
  })

  test('Check now forces a check with the running version and shows the result', async () => {
    render(<AppUpdateSettings />)
    await screen.findByText('v2.3.0')
    runAppUpdateCheck.mockImplementation(async () => {
      prefs = { ...prefs, lastCheckedAt: new Date().toISOString() }
      return { state: 'current', latest: '2.3.0' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('You have the newest version.')).toBeTruthy()
    expect(runAppUpdateCheck).toHaveBeenCalledWith({ running: '2.3.0', force: true })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check now' }).disabled).toBe(false))
  })

  test('a ready update shows its version and an Install button', async () => {
    prefs = { ...prefs, lastCheckedAt: new Date().toISOString(), ready: READY }
    installReadyUpdate.mockResolvedValue({ opened: 'installer' })
    render(<AppUpdateSettings />)
    await screen.findByText('v2.3.0')
    expect(screen.getByText('2.4.0 is ready to install.')).toBeTruthy()
    expect(screen.queryByText('You have the newest version.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Install 2.4.0' }))
    await waitFor(() => expect(installReadyUpdate).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/Android has to allow Polaris/)).toBeNull()
  })

  test('when Android has not allowed installs the card says what to do', async () => {
    prefs = { ...prefs, lastCheckedAt: new Date().toISOString(), ready: READY }
    installReadyUpdate.mockResolvedValue({ opened: 'settings' })
    render(<AppUpdateSettings />)
    await screen.findByText('v2.3.0')
    fireEvent.click(screen.getByRole('button', { name: 'Install 2.4.0' }))
    expect(await screen.findByText(
      'Android has to allow Polaris to install apps once. Allow it on the page that opened, then press Install again.',
    )).toBeTruthy()
  })

  test('a stored error shows in the banner, and an install that throws shows its message', async () => {
    prefs = { ...prefs, lastCheckedAt: new Date().toISOString(), lastError: 'GitHub did not answer (HTTP 403).' }
    render(<AppUpdateSettings />)
    expect(await screen.findByText('GitHub did not answer (HTTP 403).')).toBeTruthy()
    expect(screen.queryByText('You have the newest version.')).toBeNull()
    cleanup()
    prefs = { ...prefs, lastError: null, ready: READY }
    installReadyUpdate.mockRejectedValue(new Error('No installer.'))
    render(<AppUpdateSettings />)
    await screen.findByText('v2.3.0')
    fireEvent.click(screen.getByRole('button', { name: 'Install 2.4.0' }))
    expect(await screen.findByText('No installer.')).toBeTruthy()
  })

  test('keeps the Releases page link', async () => {
    render(<AppUpdateSettings />)
    await screen.findByText('v2.3.0')
    expect(screen.getByRole('link', { name: 'Releases page' }).getAttribute('href')).toBe('https://github.com/owenpkent/polaris/releases')
  })
})
