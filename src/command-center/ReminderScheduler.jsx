import { useCallback, useEffect, useRef, useState } from 'react'
import { useConnection } from './ConnectionContext'
import { useEventRefresh } from './useEvents'
import { MY_TASKS_QUERY } from './api'
import {
  isNativeApp,
  scheduleNotifications,
  cancelAllNotifications,
  subscribeAppResume,
} from './nativeApp'
import { loadReminderPrefs, planReminders, REMINDER_CHANGED_EVENT } from './reminders'

// Keeps the phone's scheduled notifications in step with the task list. Renders nothing, and does
// nothing outside the Android app or while reminders are off.
function Scheduler() {
  const { connected, local, api } = useConnection()
  const usable = connected || local
  const [prefs, setPrefs] = useState(loadReminderPrefs)
  const runningRef = useRef(false)
  const againRef = useRef(false)

  useEffect(() => {
    const onChange = () => setPrefs(loadReminderPrefs())
    window.addEventListener(REMINDER_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(REMINDER_CHANGED_EVENT, onChange)
  }, [])

  const sync = useCallback(async () => {
    if (runningRef.current) {
      againRef.current = true
      return
    }
    runningRef.current = true
    try {
      do {
        againRef.current = false
        try {
          if (!prefs.enabled) {
            await cancelAllNotifications()
          } else if (usable) {
            const res = await api.listTasks(MY_TASKS_QUERY)
            await scheduleNotifications(planReminders(res.tasks || [], prefs))
          }
        } catch {
          // The next change, event or resume tries again.
        }
      } while (againRef.current)
    } finally {
      runningRef.current = false
    }
  }, [api, prefs, usable])

  useEffect(() => { sync() }, [sync])
  useEffect(() => subscribeAppResume(sync), [sync])
  useEventRefresh(sync, { enabled: connected && prefs.enabled })

  return null
}

export default function ReminderScheduler() {
  return isNativeApp() ? <Scheduler /> : null
}
