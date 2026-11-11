// The phone's New task sheet keeps a draft closed with the backdrop, the X, or Esc (NewTaskSheet.jsx).
// It is kept in sessionStorage as well as in the sheet's state, so a reload of the tab keeps it:
// a background tab reloads itself onto a new build (newBuild.js), and the owner's draft must be
// there when they come back (review on #165). sessionStorage belongs to this tab alone, so a draft
// never turns up in another tab. Storage can be missing or throw: then the draft lives as long as
// the page, as before.

const KEY = 'polaris.newTaskDraft'

function storage() {
  try { return window.sessionStorage } catch { return null }
}

const str = (v) => (typeof v === 'string' ? v : '')

export function readNewTaskDraft() {
  try {
    const raw = storage()?.getItem(KEY)
    if (!raw) return null
    const d = JSON.parse(raw)
    if (!d || typeof d !== 'object') return null
    return {
      title: str(d.title),
      notes: str(d.notes),
      dueAt: typeof d.dueAt === 'string' && d.dueAt ? d.dueAt : null,
      recurrence: str(d.recurrence),
      customRepeat: d.customRepeat === true,
      projectId: str(d.projectId),
      sourceUrl: typeof d.sourceUrl === 'string' && d.sourceUrl ? d.sourceUrl : null,
    }
  } catch {
    return null
  }
}

export function writeNewTaskDraft(draft) {
  try {
    storage()?.setItem(KEY, JSON.stringify(draft))
  } catch { /* storage unavailable: the sheet's state still holds it */ }
}

export function clearNewTaskDraft() {
  try { storage()?.removeItem(KEY) } catch { /* nothing stored */ }
}
