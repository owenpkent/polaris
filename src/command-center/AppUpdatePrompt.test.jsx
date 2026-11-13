import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AppUpdatePrompt from './AppUpdatePrompt'
import { saveAppUpdatePrefs, readAppUpdatePrefs, resetPromptState, continueInstallOnResume, installReadyUpdate } from './appAutoUpdate'

let native = true
const n = {
  getAppInfo: vi.fn(),
  canInstallApps: vi.fn(),
  openInstallSettings: vi.fn(),
  installAppUpdate: vi.fn(),
  verifyAppUpdate: vi.fn(),
  requestNotificationPermission: vi.fn(),
  scheduleAppUpdateNotification: vi.fn(),
}

vi.mock('./nativeApp', () => ({
  isNativeApp: () => native,
  getAppInfo: (...a) => n.getAppInfo(...a),
  canInstallApps: (...a) => n.canInstallApps(...a),
  openInstallSettings: (...a) => n.openInstallSettings(...a),
  installAppUpdate: (...a) => n.installAppUpdate(...a),
  verifyAppUpdate: (...a) => n.verifyAppUpdate(...a),
  requestNotificationPermission: (...a) => n.requestNotificationPermission(...a),
  scheduleAppUpdateNotification: (...a) => n.scheduleAppUpdateNotification(...a),
}))

const READY = { version: '2.4.0', path: '/cache/updates/polaris-2.4.0.apk', name: 'polaris-2.4.0.apk' }

beforeEach(() => {
  native = true
  localStorage.clear()
  sessionStorage.clear()
  resetPromptState()
  Object.values(n).forEach((f) => f.mockReset())
  n.getAppInfo.mockResolvedValue({ version: '2.3.0' })
  n.canInstallApps.mockResolvedValue(true)
  n.installAppUpdate.mockResolvedValue()
  n.openInstallSettings.mockResolvedValue()
  n.verifyAppUpdate.mockResolvedValue({ ok: true })
  n.requestNotificationPermission.mockResolvedValue(true)
  n.scheduleAppUpdateNotification.mockResolvedValue()
  saveAppUpdatePrefs({ ...readAppUpdatePrefs(), ready: READY })
})

afterEach(() => cleanup())

const dialog = () => screen.findByRole('dialog', { name: 'Update ready' })

describe('AppUpdatePrompt', () => {
  test('shows for a ready newer version', async () => {
    render(<AppUpdatePrompt />)
    await dialog()
    expect(screen.getByText('Polaris 2.4.0 is downloaded and checked.')).toBeTruthy()
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Install' })))
  })

  test('not for an equal or older version, or outside the app', async () => {
    n.getAppInfo.mockResolvedValue({ version: '2.4.0' })
    render(<AppUpdatePrompt />)
    await waitFor(() => expect(n.getAppInfo).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).toBeNull()
    cleanup()
    n.getAppInfo.mockResolvedValue({ version: '2.5.0' })
    render(<AppUpdatePrompt />)
    await waitFor(() => expect(n.getAppInfo).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('dialog')).toBeNull()
    cleanup()
    native = false
    const { container } = render(<AppUpdatePrompt />)
    expect(container.innerHTML).toBe('')
  })

  test('appears when a check finishes while the app is open', async () => {
    saveAppUpdatePrefs({ ...readAppUpdatePrefs(), ready: null })
    render(<AppUpdatePrompt />)
    await waitFor(() => expect(n.getAppInfo).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => saveAppUpdatePrefs({ ...readAppUpdatePrefs(), ready: READY }))
    await dialog()
  })

  test('Later hides it, asks for permission once and posts the notification', async () => {
    render(<AppUpdatePrompt />)
    await dialog()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(n.scheduleAppUpdateNotification).toHaveBeenCalledWith({ version: '2.4.0' }))
    expect(n.requestNotificationPermission).toHaveBeenCalledTimes(1)
    expect(readAppUpdatePrefs().asked).toBe(true)
    // A newer version becomes ready: the prompt returns, and Later does not ask again.
    act(() => saveAppUpdatePrefs({ ...readAppUpdatePrefs(), ready: { ...READY, version: '2.5.0' } }))
    await dialog()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(n.requestNotificationPermission).toHaveBeenCalledTimes(1)
  })

  test('a refused permission posts nothing', async () => {
    n.requestNotificationPermission.mockResolvedValue(false)
    render(<AppUpdatePrompt />)
    await dialog()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    await waitFor(() => expect(n.requestNotificationPermission).toHaveBeenCalled())
    expect(n.scheduleAppUpdateNotification).not.toHaveBeenCalled()
  })

  test('Esc acts as Later', async () => {
    render(<AppUpdatePrompt />)
    await dialog()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(n.requestNotificationPermission).toHaveBeenCalledTimes(1)
  })

  test('Tab stays inside the dialog', async () => {
    render(<AppUpdatePrompt />)
    await dialog()
    const install = screen.getByRole('button', { name: 'Install' })
    install.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Later' }))
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(install)
  })

  test('Install calls the installer', async () => {
    render(<AppUpdatePrompt />)
    await dialog()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(n.installAppUpdate).toHaveBeenCalledWith(READY.path))
  })

  test('the permission detour installs by itself on resume when now allowed', async () => {
    n.canInstallApps.mockResolvedValueOnce(false)
    render(<AppUpdatePrompt />)
    await dialog()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(n.openInstallSettings).toHaveBeenCalled())
    expect(n.installAppUpdate).not.toHaveBeenCalled()
    await act(async () => { await continueInstallOnResume() })
    expect(n.installAppUpdate).toHaveBeenCalledWith(READY.path)
    // The pending flag is cleared: a second resume does nothing.
    await act(async () => { await continueInstallOnResume() })
    expect(n.installAppUpdate).toHaveBeenCalledTimes(1)
  })

  test('still refused on resume: the dialog returns with the extra line', async () => {
    n.canInstallApps.mockResolvedValue(false)
    render(<AppUpdatePrompt />)
    await dialog()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The notification tap, not the dialog, starts the install.
    await act(async () => { await installReadyUpdate() })
    expect(n.openInstallSettings).toHaveBeenCalled()
    await act(async () => { await continueInstallOnResume() })
    expect(n.installAppUpdate).not.toHaveBeenCalled()
    await dialog()
    expect(screen.getByText('Allow Polaris to install apps in Android settings, then come back.')).toBeTruthy()
    expect(sessionStorage.getItem('cc-app-update-pending-install')).toBeNull()
  })

  test('a resume with no pending install does nothing', async () => {
    await continueInstallOnResume()
    expect(n.installAppUpdate).not.toHaveBeenCalled()
    expect(n.verifyAppUpdate).not.toHaveBeenCalled()
  })
})
