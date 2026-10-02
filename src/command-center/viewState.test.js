import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  NO_PROJECT,
  UNASSIGNED,
  SORT_FIELDS,
  GROUP_MODES,
  activeFilterCount,
  applyFilters,
  goalWorkIndex,
  stateIndex,
  STATE_FILTER_OPTIONS,
  sortTasks,
  groupByProject,
  groupByPriority,
  useViewState,
} from './viewState'

const VIEW_STORAGE_KEY = 'cc-mytasks-view-v1'

beforeEach(() => {
  localStorage.clear()
})

describe('NO_PROJECT', () => {
  test('is a sentinel string distinct from any realistic project id', () => {
    expect(typeof NO_PROJECT).toBe('string')
    expect(NO_PROJECT.length).toBeGreaterThan(0)
  })
})

describe('SORT_FIELDS', () => {
  test('exposes exactly the four sortable fields the toolbar supports', () => {
    expect(SORT_FIELDS.map((f) => f.id)).toEqual(['due', 'priority', 'project', 'name'])
  })

  test('has unique ids and a non-empty label for every field', () => {
    const ids = SORT_FIELDS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const f of SORT_FIELDS) {
      expect(typeof f.label).toBe('string')
      expect(f.label.length).toBeGreaterThan(0)
    }
  })
})

describe('GROUP_MODES', () => {
  test('exposes exactly the four group modes the toolbar supports', () => {
    expect(GROUP_MODES.map((g) => g.id)).toEqual(['due', 'project', 'priority', 'none'])
  })

  test('has unique ids and a non-empty label for every mode', () => {
    const ids = GROUP_MODES.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const g of GROUP_MODES) {
      expect(typeof g.label).toBe('string')
      expect(g.label.length).toBeGreaterThan(0)
    }
  })
})

describe('activeFilterCount', () => {
  test('is zero when every filter category is empty', () => {
    expect(activeFilterCount({ projectIds: [], priorities: [], sources: [] })).toBe(0)
  })

  test('sums the lengths of all three filter categories', () => {
    expect(activeFilterCount({ projectIds: ['p1', 'p2'], priorities: ['high'], sources: [] })).toBe(3)
  })

  test('counts each category independently even when all are populated', () => {
    expect(activeFilterCount({ projectIds: ['p1'], priorities: ['high', 'low'], sources: ['manual'] })).toBe(4)
  })

  test('counts a chosen assignee, and a saved view without that key counts as none', () => {
    expect(activeFilterCount({ projectIds: [], priorities: [], sources: [], goalIds: [], assignees: [UNASSIGNED] })).toBe(1)
    expect(activeFilterCount({ projectIds: ['p1'], priorities: [], sources: [], goalIds: [] })).toBe(1)
  })
})

describe('applyFilters', () => {
  const tasks = [
    { id: 't1', projectId: 'p1', priority: 'high', sourceType: 'manual', assignee: 'scribe' },
    { id: 't2', projectId: 'p2', priority: 'low', sourceType: 'github', assignee: null },
    { id: 't3', projectId: null, priority: null, sourceType: null },
    { id: 't4', projectId: 'p1', priority: 'urgent', sourceType: 'github', assignee: 'reviewer' },
  ]

  test('the Unassigned filter keeps tasks whose assignee is null or missing', () => {
    const result = applyFilters(tasks, { projectIds: [], priorities: [], sources: [], assignees: [UNASSIGNED] })
    expect(result.map((t) => t.id)).toEqual(['t2', 't3'])
  })

  test('an assignee name filters by exact name, and names OR together with Unassigned', () => {
    expect(applyFilters(tasks, { projectIds: [], priorities: [], sources: [], assignees: ['scribe'] }).map((t) => t.id)).toEqual(['t1'])
    expect(applyFilters(tasks, { projectIds: [], priorities: [], sources: [], assignees: ['Scribe'] }).map((t) => t.id)).toEqual([])
    expect(applyFilters(tasks, { projectIds: [], priorities: [], sources: [], assignees: ['scribe', UNASSIGNED] }).map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })

  test('the assignee filter combines with the others as an AND', () => {
    const result = applyFilters(tasks, { projectIds: ['p1'], priorities: [], sources: [], assignees: ['reviewer'] })
    expect(result.map((t) => t.id)).toEqual(['t4'])
  })

  test('returns the exact same array reference when no filters are active', () => {
    const filters = { projectIds: [], priorities: [], sources: [] }
    expect(applyFilters(tasks, filters)).toBe(tasks)
  })

  test('filters by a single project id', () => {
    const result = applyFilters(tasks, { projectIds: ['p1'], priorities: [], sources: [] })
    expect(result.map((t) => t.id)).toEqual(['t1', 't4'])
  })

  test('matches unassigned tasks using the NO_PROJECT sentinel', () => {
    const result = applyFilters(tasks, { projectIds: [NO_PROJECT], priorities: [], sources: [] })
    expect(result.map((t) => t.id)).toEqual(['t3'])
  })

  test('treats a missing priority as "none" for filtering', () => {
    const result = applyFilters(tasks, { projectIds: [], priorities: ['none'], sources: [] })
    expect(result.map((t) => t.id)).toEqual(['t3'])
  })

  test('treats a missing sourceType as "manual" for filtering', () => {
    const result = applyFilters(tasks, { projectIds: [], priorities: [], sources: ['manual'] })
    expect(result.map((t) => t.id)).toEqual(['t1', 't3'])
  })

  test('multiple values within one category act as an OR', () => {
    const result = applyFilters(tasks, { projectIds: [], priorities: ['high', 'urgent'], sources: [] })
    expect(result.map((t) => t.id)).toEqual(['t1', 't4'])
  })

  test('multiple categories combine as an AND', () => {
    const result = applyFilters(tasks, { projectIds: ['p1'], priorities: [], sources: ['github'] })
    expect(result.map((t) => t.id)).toEqual(['t4'])
  })

  test('returns an empty array when no task satisfies all filters', () => {
    const result = applyFilters(tasks, { projectIds: ['p2'], priorities: ['urgent'], sources: [] })
    expect(result).toEqual([])
  })
})

describe('sortTasks', () => {
  test('sorts by due date ascending, with undated tasks last', () => {
    const tasks = [
      { id: 'a', dueAt: '2026-09-20' },
      { id: 'b', dueAt: null },
      { id: 'c', dueAt: '2026-09-18' },
    ]
    const result = sortTasks(tasks, { field: 'due', dir: 'asc' }, new Map())
    expect(result.map((t) => t.id)).toEqual(['c', 'a', 'b'])
  })

  test('descending due-date sort still leaves undated tasks last', () => {
    const tasks = [
      { id: 'a', dueAt: '2026-09-20' },
      { id: 'b', dueAt: null },
      { id: 'c', dueAt: '2026-09-18' },
      { id: 'd' },
    ]
    const result = sortTasks(tasks, { field: 'due', dir: 'desc' }, new Map())
    expect(result.map((t) => t.id)).toEqual(['a', 'c', 'b', 'd'])
  })

  test('undated tasks keep their original relative order in both directions', () => {
    const tasks = [{ id: 'x' }, { id: 'dated', dueAt: '2026-09-18' }, { id: 'y', dueAt: null }]
    expect(sortTasks(tasks, { field: 'due', dir: 'asc' }, new Map()).map((t) => t.id)).toEqual(['dated', 'x', 'y'])
    expect(sortTasks(tasks, { field: 'due', dir: 'desc' }, new Map()).map((t) => t.id)).toEqual(['dated', 'x', 'y'])
  })

  test('does not mutate the input array', () => {
    const tasks = [{ id: 'a', dueAt: '2026-09-20' }, { id: 'b', dueAt: '2026-09-10' }]
    const copy = [...tasks]
    sortTasks(tasks, { field: 'due', dir: 'asc' }, new Map())
    expect(tasks).toEqual(copy)
  })

  test('sorts by priority using the fixed urgent > high > medium > low > none rank', () => {
    const tasks = [
      { id: 'low', priority: 'low' },
      { id: 'urgent', priority: 'urgent' },
      { id: 'none', priority: null },
      { id: 'high', priority: 'high' },
      { id: 'medium', priority: 'medium' },
    ]
    const result = sortTasks(tasks, { field: 'priority', dir: 'asc' }, new Map())
    expect(result.map((t) => t.id)).toEqual(['urgent', 'high', 'medium', 'low', 'none'])
  })

  test('treats an unrecognized priority the same as "none"', () => {
    const tasks = [
      { id: 'weird', priority: 'blocked' },
      { id: 'none', priority: null },
      { id: 'high', priority: 'high' },
    ]
    const result = sortTasks(tasks, { field: 'priority', dir: 'asc' }, new Map())
    // 'blocked' and null both fall back to rank 4; original relative order
    // between them is preserved by the stable sort.
    expect(result.map((t) => t.id)).toEqual(['high', 'weird', 'none'])
  })

  test('reverses order for descending priority sort', () => {
    const tasks = [
      { id: 'low', priority: 'low' },
      { id: 'urgent', priority: 'urgent' },
    ]
    const result = sortTasks(tasks, { field: 'priority', dir: 'desc' }, new Map())
    expect(result.map((t) => t.id)).toEqual(['low', 'urgent'])
  })

  test('sorts by project name case-insensitively using the id-to-name map', () => {
    const projectNameById = new Map([['p1', 'banana project'], ['p2', 'Apple Project']])
    const tasks = [
      { id: 'a', projectId: 'p1' },
      { id: 'b', projectId: 'p2' },
    ]
    const result = sortTasks(tasks, { field: 'project', dir: 'asc' }, projectNameById)
    expect(result.map((t) => t.id)).toEqual(['b', 'a'])
  })

  test('sorts tasks with no resolvable project name last', () => {
    const projectNameById = new Map([['p1', 'Alpha']])
    const tasks = [
      { id: 'noproj', projectId: null },
      { id: 'unknown', projectId: 'does-not-exist' },
      { id: 'alpha', projectId: 'p1' },
    ]
    const result = sortTasks(tasks, { field: 'project', dir: 'asc' }, projectNameById)
    // Both "noproj" and "unknown" resolve to an empty name and tie, so the
    // stable sort preserves their original relative order after "alpha".
    expect(result.map((t) => t.id)).toEqual(['alpha', 'noproj', 'unknown'])
  })

  test('sorts by name using the plain (markdown-stripped) title, case-insensitively', () => {
    const tasks = [
      { id: 'b', title: '**Banana** run' },
      { id: 'a', title: 'apple pie' },
    ]
    const result = sortTasks(tasks, { field: 'name', dir: 'asc' }, new Map())
    expect(result.map((t) => t.id)).toEqual(['a', 'b'])
  })

  test('preserves relative order for ties (stable sort)', () => {
    const tasks = [
      { id: 'a', priority: 'high' },
      { id: 'b', priority: 'high' },
      { id: 'c', priority: 'high' },
    ]
    const result = sortTasks(tasks, { field: 'priority', dir: 'asc' }, new Map())
    expect(result.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('groupByProject', () => {
  test('groups tasks by projectId and labels unassigned tasks "No project"', () => {
    const projectNameById = new Map([['p1', 'Alpha Project']])
    const tasks = [
      { id: 't1', projectId: 'p1' },
      { id: 't2', projectId: null },
    ]
    const groups = groupByProject(tasks, projectNameById)
    const noProjectGroup = groups.find((g) => g.id === NO_PROJECT)
    expect(noProjectGroup.label).toBe('No project')
    expect(noProjectGroup.tasks.map((t) => t.id)).toEqual(['t2'])
  })

  test('labels a projectId missing from the map as "Unknown project"', () => {
    const groups = groupByProject([{ id: 't1', projectId: 'ghost-id' }], new Map())
    expect(groups).toEqual([{ id: 'ghost-id', label: 'Unknown project', tasks: [{ id: 't1', projectId: 'ghost-id' }] }])
  })

  test('sorts known-project groups alphabetically by label and always puts NO_PROJECT last', () => {
    const projectNameById = new Map([['p1', 'Alpha Project'], ['p2', 'Zebra Project']])
    const tasks = [
      { id: 't-zebra', projectId: 'p2' },
      { id: 't-noproj', projectId: null },
      { id: 't-unknown', projectId: 'ghost-id' },
      { id: 't-alpha', projectId: 'p1' },
    ]
    const groups = groupByProject(tasks, projectNameById)
    // Alphabetically "Alpha Project" < "Unknown project" < "Zebra Project",
    // and "No project" would normally sort between Alpha and Unknown, but
    // the NO_PROJECT id is special-cased to always be last.
    expect(groups.map((g) => g.label)).toEqual(['Alpha Project', 'Unknown project', 'Zebra Project', 'No project'])
  })

  test('returns an empty array for an empty task list', () => {
    expect(groupByProject([], new Map())).toEqual([])
  })
})

describe('groupByPriority', () => {
  test('orders present groups as urgent, high, medium, low, none', () => {
    const tasks = [
      { id: 'l', priority: 'low' },
      { id: 'u', priority: 'urgent' },
      { id: 'n', priority: null },
      { id: 'h', priority: 'high' },
      { id: 'm', priority: 'medium' },
    ]
    const groups = groupByPriority(tasks)
    expect(groups.map((g) => g.id)).toEqual(['urgent', 'high', 'medium', 'low', 'none'])
    expect(groups.map((g) => g.label)).toEqual(['Urgent', 'High', 'Medium', 'Low', 'No priority'])
  })

  test('omits groups that have no tasks', () => {
    const tasks = [{ id: 'u', priority: 'urgent' }]
    const groups = groupByPriority(tasks)
    expect(groups.map((g) => g.id)).toEqual(['urgent'])
  })

  test('tasks with an unrecognized priority are shown under No priority, never dropped', () => {
    const tasks = [
      { id: 'known', priority: 'high' },
      { id: 'weird', priority: 'blocked' },
      { id: 'plain' },
    ]
    const groups = groupByPriority(tasks)
    expect(groups.map((g) => g.id)).toEqual(['high', 'none'])
    expect(groups[1].tasks.map((t) => t.id)).toEqual(['weird', 'plain'])
    expect(groups.flatMap((g) => g.tasks)).toHaveLength(tasks.length)
  })

  test('returns an empty array for an empty task list', () => {
    expect(groupByPriority([])).toEqual([])
  })
})

describe('useViewState', () => {
  test('starts with the default view when localStorage is empty', () => {
    const { result } = renderHook(() => useViewState())
    expect(result.current.view).toEqual({
      sort: { field: 'due', dir: 'asc' },
      group: 'due',
      filters: { projectIds: [], priorities: [], sources: [], goalIds: [], states: [], assignees: [] },
    })
  })

  test('loads and normalizes a valid persisted view', () => {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      sort: { field: 'priority', dir: 'desc' },
      group: 'project',
      filters: { projectIds: ['p1'], priorities: [], sources: [], goalIds: ['g1'] },
    }))
    const { result } = renderHook(() => useViewState())
    expect(result.current.view.sort).toEqual({ field: 'priority', dir: 'desc' })
    expect(result.current.view.group).toBe('project')
    expect(result.current.view.filters.projectIds).toEqual(['p1'])
    expect(result.current.view.filters.goalIds).toEqual(['g1'])
  })

  test('a view saved before the goal filter existed loads with no goal chosen', () => {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      sort: { field: 'due', dir: 'asc' },
      group: 'due',
      filters: { projectIds: ['p1'], priorities: [], sources: [] },
    }))
    const { result } = renderHook(() => useViewState())
    expect(result.current.view.filters.goalIds).toEqual([])
  })

  test('falls back to defaults for an unrecognized sort field, direction, and group', () => {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      sort: { field: 'bogus', dir: 'sideways' },
      group: 'bogus',
      filters: {},
    }))
    const { result } = renderHook(() => useViewState())
    expect(result.current.view.sort).toEqual({ field: 'due', dir: 'asc' })
    expect(result.current.view.group).toBe('due')
    expect(result.current.view.filters).toEqual({ projectIds: [], priorities: [], sources: [], goalIds: [], states: [], assignees: [] })
  })

  test('falls back to defaults when localStorage holds corrupted JSON', () => {
    localStorage.setItem(VIEW_STORAGE_KEY, '{not valid json')
    const { result } = renderHook(() => useViewState())
    expect(result.current.view.group).toBe('due')
  })

  test('falls back to defaults when localStorage.getItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const { result } = renderHook(() => useViewState())
    expect(result.current.view).toEqual({
      sort: { field: 'due', dir: 'asc' },
      group: 'due',
      filters: { projectIds: [], priorities: [], sources: [], goalIds: [], states: [], assignees: [] },
    })
    spy.mockRestore()
  })

  test('still updates in-memory state when localStorage.setItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    const { result } = renderHook(() => useViewState())
    act(() => {
      result.current.setGroup('priority')
    })
    expect(result.current.view.group).toBe('priority')
    spy.mockRestore()
  })

  test('setSort starts a new field ascending', () => {
    const { result } = renderHook(() => useViewState())
    act(() => {
      result.current.setSort('name')
    })
    expect(result.current.view.sort).toEqual({ field: 'name', dir: 'asc' })
  })

  test('setSort toggles direction when the same field is picked again', () => {
    const { result } = renderHook(() => useViewState())
    act(() => {
      result.current.setSort('due') // already 'due' asc by default -> flips to desc
    })
    expect(result.current.view.sort).toEqual({ field: 'due', dir: 'desc' })
    act(() => {
      result.current.setSort('due')
    })
    expect(result.current.view.sort).toEqual({ field: 'due', dir: 'asc' })
  })

  test('setSort respects an explicit direction argument', () => {
    const { result } = renderHook(() => useViewState())
    act(() => {
      result.current.setSort('priority', 'desc')
    })
    expect(result.current.view.sort).toEqual({ field: 'priority', dir: 'desc' })
  })

  test('persists committed state to localStorage', () => {
    const { result } = renderHook(() => useViewState())
    act(() => {
      result.current.setGroup('none')
    })
    const saved = JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY))
    expect(saved.group).toBe('none')
  })

  test('toggleFilter adds a value and toggling it again removes it', () => {
    const { result } = renderHook(() => useViewState())
    act(() => {
      result.current.toggleFilter('priorities', 'high')
    })
    expect(result.current.view.filters.priorities).toEqual(['high'])
    act(() => {
      result.current.toggleFilter('priorities', 'high')
    })
    expect(result.current.view.filters.priorities).toEqual([])
  })

  test('clearFilters resets every filter category', () => {
    const { result } = renderHook(() => useViewState())
    act(() => {
      result.current.toggleFilter('projectIds', 'p1')
      result.current.toggleFilter('sources', 'github')
      result.current.toggleFilter('goalIds', 'g1')
      result.current.toggleFilter('assignees', UNASSIGNED)
    })
    act(() => {
      result.current.clearFilters()
    })
    expect(result.current.view.filters).toEqual({ projectIds: [], priorities: [], sources: [], goalIds: [], states: [], assignees: [] })
  })
})

describe('goal filter', () => {
  const tasks = [
    { id: 't1', projectId: 'p1', priority: 'high', sourceType: 'manual' },
    { id: 't2', projectId: 'p2', priority: 'low', sourceType: 'github' },
    { id: 't3', projectId: null, priority: null, sourceType: null },
  ]
  // g1 links project p1 and task t3 directly; g2 links project p2; g3 has no links.
  const index = goalWorkIndex([
    { id: 'g1', linkedWork: { projectIds: ['p1'], taskIds: ['t3'] } },
    { id: 'g2', linkedWork: { projectIds: ['p2'], taskIds: [] } },
    { id: 'g3' },
  ])
  const filters = (goalIds, extra = {}) => ({ projectIds: [], priorities: [], sources: [], goalIds, ...extra })

  test('keeps the tasks that move the chosen goal', () => {
    expect(applyFilters(tasks, filters(['g1']), index).map((t) => t.id)).toEqual(['t1', 't3'])
  })

  test('two goals keep the tasks of either', () => {
    expect(applyFilters(tasks, filters(['g1', 'g2']), index).map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })

  test('combines with the other filters', () => {
    expect(applyFilters(tasks, filters(['g1'], { priorities: ['high'] }), index).map((t) => t.id)).toEqual(['t1'])
  })

  test('a goal with no open tasks, or one the index does not know, matches nothing', () => {
    expect(applyFilters(tasks, filters(['g3']), index)).toEqual([])
    expect(applyFilters(tasks, filters(['gone']), index)).toEqual([])
    expect(applyFilters(tasks, filters(['g1']))).toEqual([])
  })

  test('counts toward the active filters', () => {
    expect(activeFilterCount(filters(['g1', 'g2'], { priorities: ['high'] }))).toBe(3)
  })

  // Membership follows the task as the list has it now, so an edit queued offline moves a task
  // into or out of the goal before the server has seen it.
  test('a task moved out of a linked project offline leaves the goal, and one made in it joins', () => {
    const after = [
      { id: 't1', projectId: null, priority: 'high', sourceType: 'manual' },
      { id: 't4', projectId: 'p1', priority: 'none', sourceType: null, offlineCreated: true },
      { id: 't3', projectId: null, priority: null, sourceType: null },
    ]
    expect(applyFilters(after, filters(['g1']), index).map((t) => t.id)).toEqual(['t4', 't3'])
  })

  test('a directly linked task stays in the goal whatever its project', () => {
    const moved = [{ id: 't3', projectId: 'p2', priority: null, sourceType: null }]
    expect(applyFilters(moved, filters(['g1']), index).map((t) => t.id)).toEqual(['t3'])
  })
})

describe('readiness filter', () => {
  const tasks = [
    { id: 't1', projectId: 'p1', priority: 'high', sourceType: 'manual' },
    { id: 't2', projectId: 'p2', priority: 'low', sourceType: 'github' },
    { id: 't3', projectId: null, priority: null, sourceType: null },
  ]
  // What the ready and blocked views answered: t1 and t3 can start, t2 is held by t1.
  const index = stateIndex({
    ready: { view: { name: 'ready' }, tasks: [{ id: 't1' }, { id: 't3' }] },
    blocked: { view: { name: 'blocked' }, tasks: [{ id: 't2' }], blockers: { t2: [{ id: 't1', title: 'First' }] } },
  })
  const filters = (states, extra = {}) => ({ projectIds: [], priorities: [], sources: [], goalIds: [], states, ...extra })

  test('offers exactly Ready and Blocked, named after the server views', () => {
    expect(STATE_FILTER_OPTIONS).toEqual([{ id: 'ready', label: 'Ready' }, { id: 'blocked', label: 'Blocked' }])
  })

  test('Ready keeps the tasks the ready view returned', () => {
    expect(applyFilters(tasks, filters(['ready']), new Map(), index).map((t) => t.id)).toEqual(['t1', 't3'])
  })

  test('Blocked keeps the tasks the blocked view returned', () => {
    expect(applyFilters(tasks, filters(['blocked']), new Map(), index).map((t) => t.id)).toEqual(['t2'])
  })

  test('both together keep the tasks of either, and combine with the other filters', () => {
    expect(applyFilters(tasks, filters(['ready', 'blocked']), new Map(), index).map((t) => t.id)).toEqual(['t1', 't2', 't3'])
    expect(applyFilters(tasks, filters(['ready'], { priorities: ['high'] }), new Map(), index).map((t) => t.id)).toEqual(['t1'])
  })

  test('a state whose view has not answered matches nothing', () => {
    expect(applyFilters(tasks, filters(['ready']), new Map(), stateIndex({}))).toEqual([])
    expect(applyFilters(tasks, filters(['ready']))).toEqual([])
  })

  test('counts toward the active filters', () => {
    expect(activeFilterCount(filters(['ready'], { priorities: ['high'] }))).toBe(2)
  })

  test('a saved view keeps only states the dashboard knows, and one saved before the filter existed loads with none', () => {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      sort: { field: 'due', dir: 'asc' },
      group: 'due',
      filters: { projectIds: [], priorities: [], sources: [], goalIds: [], states: ['blocked', 'someday'] },
    }))
    const { result } = renderHook(() => useViewState())
    expect(result.current.view.filters.states).toEqual(['blocked'])

    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({
      sort: { field: 'due', dir: 'asc' },
      group: 'due',
      filters: { projectIds: ['p1'], priorities: [], sources: [], goalIds: [] },
    }))
    const older = renderHook(() => useViewState())
    expect(older.result.current.view.filters.states).toEqual([])
  })
})
