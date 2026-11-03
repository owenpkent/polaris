import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AppUpdateSettings from './AppUpdateSettings'

let native = true
const getAppInfo = vi.fn()
const checkForAppUpdate = vi.fn()

vi.mock('./nativeApp', () => ({
  isNativeApp: () => native,
  getAppInfo: (...args) => getAppInfo(...args),
}))
vi.mock('./appUpdate', async () => ({
  ...(await vi.importActual('./appUpdate')),
  checkForAppUpdate: (...args) => checkForAppUpdate(...args),
}))

beforeEach(() => {
  native = true
  getAppInfo.mockReset()
  checkForAppUpdate.mockReset()
  getAppInfo.mockResolvedValue({ version: '2.3.0', build: '20300' })
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

  test('a newer release offers the apk download', async () => {
    checkForAppUpdate.mockResolvedValue({
      state: 'newer',
      latest: '2.4.0',
      apk: { name: 'polaris-2.4.0.apk', url: 'https://github.com/owenpkent/polaris/releases/download/v2.4.0/polaris-2.4.0.apk', size: 1 },
    })
    render(<AppUpdateSettings />)
    await screen.findByText('v2.3.0')
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    const link = await screen.findByRole('link', { name: 'Download polaris-2.4.0.apk' })
    expect(link.getAttribute('href')).toBe('https://github.com/owenpkent/polaris/releases/download/v2.4.0/polaris-2.4.0.apk')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByText('v2.4.0 is available.')).toBeTruthy()
    expect(checkForAppUpdate).toHaveBeenCalledWith('2.3.0')
  })

  test('a release with no apk points to the releases page', async () => {
    checkForAppUpdate.mockResolvedValue({ state: 'no-apk', latest: '2.4.0', apk: null })
    render(<AppUpdateSettings />)
    await screen.findByText('v2.3.0')
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText('v2.4.0 has no APK attached.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Releases page' }).getAttribute('href')).toBe('https://github.com/owenpkent/polaris/releases')
  })

  test('a current result says so', async () => {
    checkForAppUpdate.mockResolvedValue({ state: 'current', latest: '2.3.0', apk: null })
    render(<AppUpdateSettings />)
    await screen.findByText('v2.3.0')
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText('You have the newest version.')).toBeTruthy()
  })

  test('a release with no version says so', async () => {
    checkForAppUpdate.mockResolvedValue({ state: 'unknown', latest: null, apk: null })
    render(<AppUpdateSettings />)
    await screen.findByText('v2.3.0')
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText('The newest release has no version.')).toBeTruthy()
  })

  test('an error shows the banner and the button works again', async () => {
    checkForAppUpdate.mockRejectedValue(new Error('GitHub did not answer (HTTP 403).'))
    render(<AppUpdateSettings />)
    await screen.findByText('v2.3.0')
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText('GitHub did not answer (HTTP 403).')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check for updates' }).disabled).toBe(false))
  })
})
