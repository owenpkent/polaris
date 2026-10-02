// Pure helpers for the Goals view: no React, no network, so they can be unit tested directly.

export const GOAL_STATUS_OPTIONS = [
  { value: 'on_track', label: 'On track', color: 'var(--green)', soft: 'var(--green-soft)' },
  { value: 'at_risk', label: 'At risk', color: 'var(--yellow)', soft: 'var(--yellow-soft)' },
  { value: 'off_track', label: 'Off track', color: 'var(--red)', soft: 'var(--red-soft)' },
  { value: 'achieved', label: 'Achieved', color: 'var(--blue)', soft: 'var(--blue-soft)' },
  { value: 'dropped', label: 'Dropped', color: 'var(--t2)', soft: 'var(--neutral-soft)' },
]

export function statusOption(value) {
  return GOAL_STATUS_OPTIONS.find((o) => o.value === value) || GOAL_STATUS_OPTIONS[0]
}

// Same threshold the daily digest uses (command-center/src/automation/digest.ts).
export const GOAL_STALE_DAYS = 14

const CLOSED = new Set(['achieved', 'dropped'])

function daysBetween(fromDate, toDate) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000)
}

// What needs attention on an open goal: nothing open to move it, or no status update lately.
// `today` is a local YYYY-MM-DD string. Closed goals never need attention.
export function goalFlags(goal, today) {
  if (CLOSED.has(goal.status)) return []
  const flags = []
  if ((goal.progress?.openTasks ?? 0) === 0) flags.push({ key: 'stalled', label: 'Stalled: no open task' })
  const since = goal.statusUpdatedAt ? daysBetween(goal.statusUpdatedAt.slice(0, 10), today) : null
  if (since === null) flags.push({ key: 'stale', label: 'No status update yet' })
  else if (since >= GOAL_STALE_DAYS) flags.push({ key: 'stale', label: `No update in ${since} days` })
  return flags
}

export function progressLabel(goal) {
  const p = goal.progress
  if (!p) return ''
  if (p.mode === 'manual') {
    if (goal.currentValue == null || goal.targetValue == null) return 'No value set yet'
    const unit = goal.unit ? ` ${goal.unit}` : ''
    return `${goal.currentValue} of ${goal.targetValue}${unit}${p.percent != null ? ` (${p.percent}%)` : ''}`
  }
  if (!p.total) return 'Nothing linked to count yet'
  return `${p.done} of ${p.total} done (${p.percent}%)`
}

// Flat list in display order, each goal carrying its depth. A goal whose parent is missing from
// the list (for example a closed parent while closed goals are hidden) is shown at the top level.
// A cycle cannot hang this: every goal is visited once.
export function flattenGoalTree(goals) {
  const byId = new Map(goals.map((g) => [g.id, g]))
  const children = new Map()
  const roots = []
  for (const goal of goals) {
    if (goal.parentId && byId.has(goal.parentId)) {
      if (!children.has(goal.parentId)) children.set(goal.parentId, [])
      children.get(goal.parentId).push(goal)
    } else {
      roots.push(goal)
    }
  }
  const out = []
  const seen = new Set()
  const visit = (goal, depth) => {
    if (seen.has(goal.id)) return
    seen.add(goal.id)
    out.push({ goal, depth })
    for (const child of children.get(goal.id) || []) visit(child, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  // Anything left is part of a parent cycle; show it rather than lose it.
  for (const goal of goals) visit(goal, 0)
  return out
}

// One-click period choices for the Add goal form, so the period rarely has to be typed.
export function periodSuggestions(now = new Date()) {
  const year = now.getFullYear()
  const quarter = Math.floor(now.getMonth() / 3) + 1
  const pad = (n) => String(n).padStart(2, '0')
  const quarterStartMonth = (quarter - 1) * 3
  const quarterEnd = new Date(year, quarterStartMonth + 3, 0)
  return [
    { label: `${year} Q${quarter}`, startsOn: `${year}-${pad(quarterStartMonth + 1)}-01`, endsOn: `${year}-${pad(quarterEnd.getMonth() + 1)}-${pad(quarterEnd.getDate())}` },
    { label: `${year}`, startsOn: `${year}-01-01`, endsOn: `${year}-12-31` },
    { label: `${year + 1}`, startsOn: `${year + 1}-01-01`, endsOn: `${year + 1}-12-31` },
  ]
}

// ---- one-time import of the old browser-only Goals tab ----

export const LEGACY_STORAGE_KEY = 'constellation-v2'
export const IMPORT_DONE_KEY = 'cc-goals-imported-v1'

// Reads the goals the old tab kept in localStorage and turns them into goal drafts. Returns null
// when there is nothing worth importing. Never throws: storage can be blocked or hold bad JSON.
export function readLegacyGoals(storage, now = new Date()) {
  let saved
  try {
    const raw = storage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return null
    saved = JSON.parse(raw)
  } catch {
    return null
  }
  const legacy = saved && typeof saved === 'object' ? saved.goals : null
  if (!legacy || typeof legacy !== 'object') return null

  const [thisQuarter, thisYear] = periodSuggestions(now)
  const text = (v) => (typeof v === 'string' ? v.trim() : '')
  const goals = []
  for (const title of Array.isArray(legacy.annual) ? legacy.annual : []) {
    if (text(title)) goals.push({ title: text(title), periodLabel: thisYear.label, startsOn: thisYear.startsOn, endsOn: thisYear.endsOn })
  }
  if (text(legacy.quarterly)) {
    goals.push({ title: text(legacy.quarterly), periodLabel: thisQuarter.label, startsOn: thisQuarter.startsOn, endsOn: thisQuarter.endsOn })
  }
  for (const m of Array.isArray(legacy.milestones) ? legacy.milestones : []) {
    const title = text(m?.title)
    if (title) goals.push({ title, periodLabel: thisYear.label, startsOn: thisYear.startsOn, endsOn: thisYear.endsOn, status: m.done ? 'achieved' : 'on_track' })
  }
  const vision = text(legacy.vision)
  if (!vision && goals.length === 0) return null
  return { vision, goals }
}

export function importAlreadyDone(storage) {
  try {
    return storage.getItem(IMPORT_DONE_KEY) === '1'
  } catch {
    return true
  }
}

export function markImportDone(storage) {
  try {
    storage.setItem(IMPORT_DONE_KEY, '1')
  } catch {
    // Storage is blocked; the banner will simply offer the import again next time.
  }
}
