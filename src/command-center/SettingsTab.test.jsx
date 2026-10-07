import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import SettingsTab from './SettingsTab'

vi.mock('./SettingsForm', () => ({ default: () => <div>connection card</div> }))
vi.mock('./AgentSettings', () => ({ default: () => <div>agents card</div> }))
vi.mock('./BackupSettings', () => ({ default: () => <div>backups card</div> }))
vi.mock('./ReminderSettings', () => ({ default: () => <div>reminders card</div> }))
vi.mock('./ImportTasks', () => ({ default: () => <div>import card</div> }))

afterEach(() => {
  cleanup()
  delete window.Capacitor
})

describe('SettingsTab', () => {
  test('lists every section and jumps focus to the one picked', () => {
    // jsdom has no layout, so scrolling is a no-op to stub.
    Element.prototype.scrollIntoView = vi.fn()
    render(<SettingsTab theme="system" onThemeChange={() => {}} />)
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    const names = Array.from(nav.querySelectorAll('button')).map((b) => b.textContent)
    expect(names).toEqual(['Connection', 'Appearance', 'Agents', 'Backups', 'Import tasks'])

    fireEvent.click(screen.getByRole('button', { name: 'Import tasks' }))
    expect(document.activeElement.id).toBe('settings-import')
    expect(document.activeElement.textContent).toBe('import card')
  })

  test('the theme choice is the one App holds, and picking one reports it', () => {
    const onThemeChange = vi.fn()
    render(<SettingsTab theme="dark" onThemeChange={onThemeChange} />)
    expect(screen.getByRole('radio', { name: 'Dark' }).checked).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(onThemeChange).toHaveBeenCalledWith('light')
  })

  test('the reminders section is there only in the Android app', () => {
    window.Capacitor = { isNativePlatform: () => true }
    render(<SettingsTab theme="system" onThemeChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Reminders' })).toBeTruthy()
  })
})
