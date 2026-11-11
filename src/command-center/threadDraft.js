// The thread post box and the fork title are kept per task in localStorage, so closing the panel,
// or opening another task from it, never loses what was typed and never carries it to another
// task's box. A post is sent only by Post (CONTRIBUTING.md, "Leaving an edit"), so leaving keeps
// the draft instead of sending it. Storage can be missing or throw (private mode, quota): then the
// draft lives only as long as the component, as before.

const PREFIX = 'polaris.threadDraft.'
const POST_TYPES = ['claim', 'evidence', 'objection', 'question', 'failed_attempt', 'summary', 'result']

function storage() {
  try { return window.localStorage } catch { return null }
}

export function emptyDraft() {
  return { body: '', type: 'claim', fork: '' }
}

export function readThreadDraft(taskId) {
  const out = emptyDraft()
  if (!taskId) return out
  try {
    const raw = storage()?.getItem(PREFIX + taskId)
    if (!raw) return out
    const saved = JSON.parse(raw)
    if (typeof saved?.body === 'string') out.body = saved.body
    if (typeof saved?.fork === 'string') out.fork = saved.fork
    if (POST_TYPES.includes(saved?.type)) out.type = saved.type
  } catch { /* unreadable or storage unavailable: start empty */ }
  return out
}

// An empty box and an empty fork title leave nothing behind, so the key is removed.
export function writeThreadDraft(taskId, draft) {
  if (!taskId) return
  try {
    const store = storage()
    if (!store) return
    if (!draft.body.trim() && !draft.fork.trim()) store.removeItem(PREFIX + taskId)
    else store.setItem(PREFIX + taskId, JSON.stringify({ body: draft.body, type: draft.type, fork: draft.fork }))
  } catch { /* storage unavailable: the draft is kept in memory only */ }
}
