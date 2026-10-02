import { describe, test, expect } from 'vitest'
import {
  GOAL_STALE_DAYS, GOAL_STATUS_OPTIONS, IMPORT_DONE_KEY, LEGACY_STORAGE_KEY, flattenGoalTree, goalFlags,
  importAlreadyDone, markImportDone, periodSuggestions, progressLabel, readLegacyGoals, statusOption,
} from './goalsModel'

const goal = (over = {}) => ({
  id: 'g1', title: 'Goal', status: 'on_track', parentId: null, statusUpdatedAt: '2026-09-18T09:00:00.000Z',
  progressMode: 'tasks', currentValue: null, targetValue: null, unit: null,
  progress: { mode: 'tasks', done: 1, total: 2, percent: 50, openTasks: 1 },
  ...over,
})

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    data,
  }
}

const throwingStorage = {
  getItem: () => { throw new Error('blocked') },
  setItem: () => { throw new Error('blocked') },
}

describe('statusOption', () => {
  test('covers the five server statuses, each with a token colour and no colour literals', () => {
    expect(GOAL_STATUS_OPTIONS.map((o) => o.value)).toEqual(['on_track', 'at_risk', 'off_track', 'achieved', 'dropped'])
    for (const o of GOAL_STATUS_OPTIONS) {
      expect(o.color).toMatch(/^var\(--/)
      expect(o.soft).toMatch(/^var\(--/)
    }
  })

  test('falls back to the first option for an unknown status', () => {
    expect(statusOption('at_risk').label).toBe('At risk')
    expect(statusOption('nonsense').value).toBe('on_track')
  })
})

describe('goalFlags', () => {
  test('a goal with open work and a recent update needs nothing', () => {
    expect(goalFlags(goal(), '2026-09-18')).toEqual([])
  })

  test('no open task is flagged as stalled', () => {
    const flags = goalFlags(goal({ progress: { mode: 'tasks', done: 2, total: 2, percent: 100, openTasks: 0 } }), '2026-09-18')
    expect(flags.map((f) => f.key)).toEqual(['stalled'])
  })

  test('the stale flag starts at exactly the digest threshold', () => {
    expect(GOAL_STALE_DAYS).toBe(14)
    const g = goal({ statusUpdatedAt: '2026-09-01T23:30:00.000Z' })
    expect(goalFlags(g, '2026-09-14')).toEqual([])
    expect(goalFlags(g, '2026-09-15')).toEqual([{ key: 'stale', label: 'No update in 14 days' }])
    expect(goalFlags(g, '2026-10-01')[0].label).toBe('No update in 30 days')
  })

  test('a goal that never had a status update says so', () => {
    expect(goalFlags(goal({ statusUpdatedAt: null }), '2026-09-18')).toEqual([{ key: 'stale', label: 'No status update yet' }])
  })

  test('achieved and dropped goals never need attention', () => {
    const closed = { statusUpdatedAt: '2020-01-01T00:00:00.000Z', progress: { mode: 'tasks', done: 0, total: 0, percent: null, openTasks: 0 } }
    expect(goalFlags(goal({ ...closed, status: 'achieved' }), '2026-09-18')).toEqual([])
    expect(goalFlags(goal({ ...closed, status: 'dropped' }), '2026-09-18')).toEqual([])
  })

  test('a goal with no progress object is treated as having no open task', () => {
    expect(goalFlags(goal({ progress: undefined }), '2026-09-18').map((f) => f.key)).toEqual(['stalled'])
  })
})

describe('progressLabel', () => {
  test('counted tasks', () => {
    expect(progressLabel(goal())).toBe('1 of 2 done (50%)')
  })

  test('nothing linked yet', () => {
    expect(progressLabel(goal({ progress: { mode: 'tasks', done: 0, total: 0, percent: null, openTasks: 0 } }))).toBe('Nothing linked to count yet')
  })

  test('manual value with and without a unit or a percent', () => {
    const manual = { progressMode: 'manual', currentValue: 250, targetValue: 1000 }
    expect(progressLabel(goal({ ...manual, unit: 'subscribers', progress: { mode: 'manual', percent: 25, openTasks: 0 } }))).toBe('250 of 1000 subscribers (25%)')
    expect(progressLabel(goal({ ...manual, progress: { mode: 'manual', percent: null, openTasks: 0 } }))).toBe('250 of 1000')
  })

  test('manual goal with no value yet, and a goal with no progress at all', () => {
    expect(progressLabel(goal({ progress: { mode: 'manual', percent: null, openTasks: 0 } }))).toBe('No value set yet')
    expect(progressLabel(goal({ progress: undefined }))).toBe('')
  })
})

describe('flattenGoalTree', () => {
  const g = (id, parentId = null) => ({ id, parentId })

  test('children follow their parent, one level deeper, in the order given', () => {
    const rows = flattenGoalTree([g('a'), g('b'), g('a1', 'a'), g('a2', 'a'), g('a1x', 'a1')])
    expect(rows.map((r) => [r.goal.id, r.depth])).toEqual([['a', 0], ['a1', 1], ['a1x', 2], ['a2', 1], ['b', 0]])
  })

  test('a goal whose parent is not in the list is shown at the top level', () => {
    const rows = flattenGoalTree([g('child', 'hidden-closed-parent'), g('other')])
    expect(rows.map((r) => [r.goal.id, r.depth])).toEqual([['child', 0], ['other', 0]])
  })

  test('a parent cycle cannot hang it or lose a goal', () => {
    const rows = flattenGoalTree([g('x', 'y'), g('y', 'x'), g('z')])
    expect(rows.map((r) => r.goal.id).sort()).toEqual(['x', 'y', 'z'])
  })

  test('an empty list is an empty list', () => {
    expect(flattenGoalTree([])).toEqual([])
  })
})

describe('periodSuggestions', () => {
  test('offers this quarter, this year, and next year with exact date ranges', () => {
    expect(periodSuggestions(new Date(2026, 8, 18))).toEqual([
      { label: '2026 Q3', startsOn: '2026-07-01', endsOn: '2026-09-30' },
      { label: '2026', startsOn: '2026-01-01', endsOn: '2026-12-31' },
      { label: '2027', startsOn: '2027-01-01', endsOn: '2027-12-31' },
    ])
  })

  test('quarter boundaries: January is Q1, December is Q4 and ends on the 31st', () => {
    expect(periodSuggestions(new Date(2026, 0, 1))[0]).toEqual({ label: '2026 Q1', startsOn: '2026-01-01', endsOn: '2026-03-31' })
    expect(periodSuggestions(new Date(2026, 11, 31))[0]).toEqual({ label: '2026 Q4', startsOn: '2026-10-01', endsOn: '2026-12-31' })
    expect(periodSuggestions(new Date(2026, 3, 1))[0].endsOn).toBe('2026-06-30')
  })
})

describe('readLegacyGoals', () => {
  const now = new Date(2026, 8, 18)
  const save = (goals) => fakeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify({ goals }) })

  test('maps annual goals, the quarterly focus, and milestones to goal drafts', () => {
    const result = readLegacyGoals(save({
      vision: '  Ship open tools.  ',
      annual: ['Release three tools', '   '],
      quarterly: 'Get the sample video out',
      milestones: [{ id: 'm1', title: 'Nimbus v3', done: false }, { id: 'm2', title: 'Book outline', done: true }, { id: 'm3' }],
    }), now)
    expect(result.vision).toBe('Ship open tools.')
    expect(result.goals).toEqual([
      { title: 'Release three tools', periodLabel: '2026', startsOn: '2026-01-01', endsOn: '2026-12-31' },
      { title: 'Get the sample video out', periodLabel: '2026 Q3', startsOn: '2026-07-01', endsOn: '2026-09-30' },
      { title: 'Nimbus v3', periodLabel: '2026', startsOn: '2026-01-01', endsOn: '2026-12-31', status: 'on_track' },
      { title: 'Book outline', periodLabel: '2026', startsOn: '2026-01-01', endsOn: '2026-12-31', status: 'achieved' },
    ])
  })

  test('returns null when there is nothing to import', () => {
    expect(readLegacyGoals(fakeStorage(), now)).toBeNull()
    expect(readLegacyGoals(save({ vision: '', annual: [], quarterly: '', milestones: [] }), now)).toBeNull()
    expect(readLegacyGoals(fakeStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify({ projects: [] }) }), now)).toBeNull()
  })

  test('a vision on its own is still worth importing', () => {
    expect(readLegacyGoals(save({ vision: 'Only this' }), now)).toEqual({ vision: 'Only this', goals: [] })
  })

  test('never throws on bad JSON, wrong shapes, or blocked storage', () => {
    expect(readLegacyGoals(fakeStorage({ [LEGACY_STORAGE_KEY]: '{not json' }), now)).toBeNull()
    expect(readLegacyGoals(fakeStorage({ [LEGACY_STORAGE_KEY]: '"a string"' }), now)).toBeNull()
    expect(readLegacyGoals(save({ annual: 'not a list', milestones: { nope: true }, vision: 42 }), now)).toBeNull()
    expect(readLegacyGoals(throwingStorage, now)).toBeNull()
  })
})

describe('import bookkeeping', () => {
  test('marking the import done is remembered', () => {
    const storage = fakeStorage()
    expect(importAlreadyDone(storage)).toBe(false)
    markImportDone(storage)
    expect(storage.data.get(IMPORT_DONE_KEY)).toBe('1')
    expect(importAlreadyDone(storage)).toBe(true)
  })

  test('blocked storage counts as done, so the import is never offered blindly, and marking does not throw', () => {
    expect(importAlreadyDone(throwingStorage)).toBe(true)
    expect(() => markImportDone(throwingStorage)).not.toThrow()
  })
})
