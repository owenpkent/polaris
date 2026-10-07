import { useRef } from 'react'
import SettingsForm from './SettingsForm'
import AgentSettings from './AgentSettings'
import BackupSettings from './BackupSettings'
import ReminderSettings from './ReminderSettings'
import ImportTasks from './ImportTasks'
import AppearanceSettings from './AppearanceSettings'
import { isNativeApp } from './nativeApp'

// Every setting on one page, one card per area, with a row of jump buttons at the top so a long
// page on a phone is one tap from any card. The jump moves focus to the card as well as scrolling,
// so a keyboard or screen reader user lands where a sighted one does.
export default function SettingsTab({ theme, onThemeChange }) {
  const refs = useRef({})
  const sections = [
    { id: 'connection', label: 'Connection', node: <SettingsForm /> },
    { id: 'appearance', label: 'Appearance', node: <AppearanceSettings theme={theme} onThemeChange={onThemeChange} /> },
    { id: 'agents', label: 'Agents', node: <AgentSettings /> },
    // Reminders are scheduled on the phone, so the card exists only in the Android app.
    ...(isNativeApp() ? [{ id: 'reminders', label: 'Reminders', node: <ReminderSettings /> }] : []),
    { id: 'backups', label: 'Backups', node: <BackupSettings /> },
    { id: 'import', label: 'Import tasks', node: <ImportTasks /> },
  ]

  function jump(id) {
    const el = refs.current[id]
    if (!el) return
    el.focus({ preventScroll: true })
    el.scrollIntoView({ block: 'start' })
  }

  return (
    <div className="settings-page">
      <nav aria-label="Settings sections" className="settings-jump">
        {sections.map((s) => (
          <button key={s.id} type="button" className="btn btn-ghost" onClick={() => jump(s.id)}>
            {s.label}
          </button>
        ))}
      </nav>
      {sections.map((s) => (
        <div
          key={s.id}
          id={`settings-${s.id}`}
          ref={(el) => { refs.current[s.id] = el }}
          tabIndex={-1}
          className="settings-section"
        >
          {s.node}
        </div>
      ))}
    </div>
  )
}
