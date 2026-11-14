import { getOfflineState } from './offlineStatus'

// Undo on a completed repeating task: completing it made the next copy, so reopening it alone
// leaves two of the same task. The copy goes (dropped, the dashboard's way to remove a task) only
// while it is as it was made: still open and not edited since. One the owner has already changed,
// or that cannot be read (offline, gone), stays, so the worst case is the two copies as before.
export async function dropUntouchedNext(api, next) {
  if (!next?.id) return
  try {
    const current = (await api.getTask(next.id))?.task
    // Out of reach, the answer is the stored copy, which can miss an edit made elsewhere, and the
    // drop would be queued blind. The copy stays.
    if (getOfflineState().offline) return
    if (!current || current.status !== 'open' || current.updatedAt !== next.updatedAt) return
    await api.updateTask(next.id, { status: 'dropped' })
  } catch {
    // The reopen has already happened; a copy left behind is visible and can be dropped by hand.
  }
}
