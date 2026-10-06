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
import { subscribeTaskChanges } from './taskChanges'

// Keeps the phone's scheduled notifications in step with the task list. Renders nothing, and does
// nothing outside the Android app or while reminders are off.
//
// It resyncs when the prefs or the connection change, when the app resumes, when the server
// reports a change (/api/events), and when this device changes a task (taskChanges.js). The last
// one is what covers a task completed offline or made in local mode, where no event ever arrives.
function Scheduler() {
  const { connected, local, api } = useConnection()
  const usable = connected || local
  const [prefs, setPrefs] = useState(loadReminderPrefs)
  const runningRef = useRef(false)
  const againRef = useRef(false)
  // What a sync works from, read afresh on every pass: a pass that started before the prefs
  // changed must not finish with the old ones (scheduling after reminders were turned off).
  const stateRef = useRef({ prefs, usable, api })
  stateRef.current = { prefs, usable, api }

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
        const { prefs: current, usable: canRead, api: client } = stateRef.current
        try {
          if (!current.enabled) {
            await cancelAllNotifications()
          } else if (canRead) {
            const res = await client.listTasks(MY_TASKS_QUERY)
            // Something changed while the list loaded: the next pass works from the newer state.
            if (againRef.current) continue
            await scheduleNotifications(planReminders(res.tasks || [], current))
          }
        } catch {
          // The next change, event or resume tries again.
        }
      } while (againRef.current)
    } finally {
      runningRef.current = false
    }
  }, [])

  useEffect(() => { sync() }, [sync, prefs, usable, api])
  useEffect(() => subscribeAppResume(sync), [sync])
  useEffect(() => subscribeTaskChanges(() => {
    if (stateRef.current.prefs.enabled) sync()
  }), [sync])
  useEventRefresh(sync, { enabled: connected && prefs.enabled })

  return null
}

export default function ReminderScheduler() {
  return isNativeApp() ? <Scheduler /> : null
}
