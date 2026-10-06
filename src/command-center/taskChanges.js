// A signal that this device just changed a task: online, offline, or in local mode. The task
// writes in api.js raise it once the server took the change, and outbox.js raises it once a
// queued change is in the local copy. /api/events only reports changes while the server answers,
// so anything that must follow edits made with no server, such as the phone's reminders
// (ReminderScheduler.jsx), listens here too.

const listeners = new Set()

/** Calls `fn` after each task change made on this device. Returns an unsubscribe. */
export function subscribeTaskChanges(fn) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Tells every listener a task changed. A listener that throws does not stop the others. */
export function notifyTaskChanges() {
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch {
      // A listener's failure is its own.
    }
  }
}
