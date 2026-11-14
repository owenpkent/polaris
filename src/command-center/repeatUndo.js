// Undo on a completed repeating task: completing it made the next copy, so reopening it alone
// leaves two of the same task. The copy goes (dropped, the dashboard's way to remove a task) only
// while it is as it was made. The server decides that, in the same transaction as the drop: the
// write names the updatedAt the copy was made with and is refused if anything has changed it
// since. It is live only, so out of reach of the server nothing is dropped and nothing is queued.
// A copy that stays is the two tasks as before, never a lost one.
export async function dropUntouchedNext(api, next) {
  if (!next?.id || !next.updatedAt) return
  try {
    await api.updateTaskIfUnchanged(next.id, { status: 'dropped' }, next.updatedAt)
  } catch {
    // The reopen has already happened; a copy left behind is visible and can be dropped by hand.
  }
}
