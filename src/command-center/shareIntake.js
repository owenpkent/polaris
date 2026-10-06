// Quick add from a share. Shared text or a link reaches the dashboard as query parameters: the
// web app manifest's share_target (installed PWA) and the Android shell (which turns a share
// intent into an appUrlOpen carrying the same parameters) both use these three names. The
// dashboard opens the new-task sheet prefilled so the owner confirms or edits before saving.
// A share is the owner's own action, like pasting, so nothing here marks the text as third-party.

const SHARE_PARAMS = ['share-title', 'share-text', 'share-url']
const URL_PATTERN = /https?:\/\/[^\s<>"']+/i

/** Reads the three share parameters from a query string. Null when none carries any text. */
export function parseShareParams(search) {
  let params
  try {
    params = new URLSearchParams(search || '')
  } catch {
    return null
  }
  const read = (name) => (params.get(name) || '').trim()
  const share = { title: read('share-title'), text: read('share-text'), url: read('share-url') }
  return share.title || share.text || share.url ? share : null
}

/** Turns a parsed share into the new-task sheet's starting fields. */
export function shareToTaskFields({ title = '', text = '', url = '' } = {}) {
  const found = text.match(URL_PATTERN)?.[0]
  // A sentence-ending mark right after a link is not part of it.
  const textUrl = found ? found.replace(/[.,;:!?)\]]+$/, '') : null
  const sourceUrl = url || textUrl || null

  let chosen = title
  if (!chosen && text) {
    const firstLine = (text.split(/\r?\n/).map((line) => line.trim()).find((line) => line) || '')
    const withoutUrl = found ? firstLine.replace(found, '').trim() : firstLine
    chosen = withoutUrl
  }
  if (!chosen) chosen = sourceUrl || 'Shared item'

  const onlyUrl = text === sourceUrl || (textUrl !== null && text === textUrl)
  const notes = text && text !== chosen && !onlyUrl ? text : ''
  return { title: chosen, notes, sourceUrl }
}

/** Removes the share parameters from the address bar, keeping every other parameter and the hash. */
export function stripShareParams() {
  try {
    const params = new URLSearchParams(window.location.search)
    if (!SHARE_PARAMS.some((name) => params.has(name))) return
    for (const name of SHARE_PARAMS) params.delete(name)
    const search = params.toString()
    const url = window.location.pathname + (search ? `?${search}` : '') + window.location.hash
    window.history.replaceState(null, '', url)
  } catch {
    // Ignore URL/history errors; the share is already in state.
  }
}
