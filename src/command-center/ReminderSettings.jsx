import { useState } from 'react'
import { ErrorBanner } from './shared'
import { isNativeApp, requestNotificationPermission } from './nativeApp'
import { loadReminderPrefs, saveReminderPrefs } from './reminders'

// Due-date reminders, Android app only. Per device: the choices live in this browser's storage and
// ReminderScheduler turns them into notifications scheduled on the phone.
export default function ReminderSettings() {
  const [prefs, setPrefs] = useState(loadReminderPrefs)
  const [error, setError] = useState(null)

  if (!isNativeApp()) return null

  function update(next) {
    setPrefs(next)
    saveReminderPrefs(next)
  }

  async function toggle(checked) {
    setError(null)
    if (!checked) {
      update({ ...prefs, enabled: false })
      return
    }
    let granted = false
    try {
      granted = await requestNotificationPermission()
    } catch {
      granted = false
    }
    if (!granted) {
      setError('Notifications are turned off for Polaris in Android settings.')
      return
    }
    update({ ...prefs, enabled: true })
  }

  return (
    <section className="card" aria-labelledby="cc-reminders-heading" style={{ marginTop: '1.5rem' }}>
      <div className="section-header" id="cc-reminders-heading">Reminders</div>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          fontSize: '0.8rem',
          color: 'var(--t2)',
          cursor: 'pointer',
          minHeight: 44,
          padding: '0 4px',
          borderRadius: 'var(--radius)',
        }}
      >
        <input
          type="checkbox"
          checked={prefs.enabled}
          onChange={(e) => toggle(e.target.checked)}
          style={{ width: 18, height: 18 }}
        />
        Remind me on the day a task is due
      </label>

      <div className="field" style={{ marginTop: '0.75rem' }}>
        <label htmlFor="cc-reminder-time">Time</label>
        <input
          id="cc-reminder-time"
          type="time"
          value={prefs.time}
          disabled={!prefs.enabled}
          onChange={(e) => {
            if (e.target.value) update({ ...prefs, time: e.target.value })
          }}
        />
      </div>

      <p style={{ fontSize: '0.8rem', color: 'var(--t2)', marginTop: '0.75rem', marginBottom: error ? '0.75rem' : 0 }}>
        Reminders are scheduled on this phone from the task list. Nothing is sent anywhere.
      </p>

      {error && <ErrorBanner message={error} />}
    </section>
  )
}
