import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import GoalsTab from './GoalsTab'
import { IMPORT_DONE_KEY, LEGACY_STORAGE_KEY } from './goalsModel'
import { markOffline, resetOfflineStatus } from './offlineStatus'

const api = {}
let connected = true

vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected, api }) }))
vi.mock('./useEvents', () => ({ useEventRefresh: () => {} }))

const progress = { mode: 'tasks', done: 0, total: 0, percent: null, openTasks: 0 }
const serverGoal = (over = {}) => ({
  id: 'g1', title: 'Existing goal', status: 'on_track', parentId: null, periodLabel: '2026', statusNote: '',
  statusUpdatedAt: new Date().toISOString(), progressMode: 'tasks', currentValue: null, targetValue: null, unit: null,
  updatedAt: '2026-09-18T00:00:00.000Z', progress: { ...progress, openTasks: 1 }, links: [], childIds: [], ...over,
})

function saveLegacy(goals) {
  localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ goals }))
}

beforeEach(() => {
  connected = true
  localStorage.clear()
  Object.assign(api, {
    listGoals: vi.fn().mockResolvedValue({ goals: [], total: 0, vision: '' }),
    listProjects: vi.fn().mockResolvedValue({ projects: [] }),
    createGoal: vi.fn().mockResolvedValue({ goal: { id: 'new' } }),
    setGoalVision: vi.fn().mockResolvedValue({ vision: '' }),
    updateGoal: vi.fn().mockResolvedValue({}),
    getGoal: vi.fn().mockResolvedValue({ goal: serverGoal(), linkedProjects: [], linkedTasks: [], openTasks: [] }),
  })
})

afterEach(() => cleanup())

describe('GoalsTab import offer', () => {
  test('offers the import when the server has no goals and this browser still holds old ones', async () => {
    saveLegacy({ vision: 'Old vision', annual: ['Release three tools'], quarterly: 'Get the video out', milestones: [{ id: 'm1', title: 'Nimbus v3', done: true }] })
    render(<GoalsTab />)
    const banner = await screen.findByRole('region', { name: 'Import goals from this browser' })
    expect(banner.textContent).toContain('3 goals')
    expect(banner.textContent).toContain('plus a vision statement')
  })

  test('Import creates every goal and the vision once, then never offers again', async () => {
    saveLegacy({ vision: 'Old vision', annual: ['Release three tools'], quarterly: '', milestones: [{ id: 'm1', title: 'Nimbus v3', done: true }] })
    render(<GoalsTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 goals' }))
    await waitFor(() => expect(api.createGoal).toHaveBeenCalledTimes(2))
    expect(api.setGoalVision).toHaveBeenCalledWith('Old vision')
    expect(api.createGoal.mock.calls.map(([g]) => [g.title, g.status])).toEqual([['Release three tools', undefined], ['Nimbus v3', 'achieved']])
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Import goals from this browser' })).toBeNull())
    expect(localStorage.getItem(IMPORT_DONE_KEY)).toBe('1')
  })

  test('an existing server vision is not overwritten by the import', async () => {
    api.listGoals.mockResolvedValue({ goals: [], total: 0, vision: 'Server vision' })
    saveLegacy({ vision: 'Old vision', annual: ['A goal'] })
    render(<GoalsTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 goal' }))
    await waitFor(() => expect(api.createGoal).toHaveBeenCalledTimes(1))
    expect(api.setGoalVision).not.toHaveBeenCalled()
  })

  test('Not now hides the offer for good and creates nothing', async () => {
    saveLegacy({ annual: ['A goal'] })
    render(<GoalsTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('region', { name: 'Import goals from this browser' })).toBeNull()
    expect(api.createGoal).not.toHaveBeenCalled()
    expect(localStorage.getItem(IMPORT_DONE_KEY)).toBe('1')
  })

  test('no offer when the server already has goals, even if they are all closed and hidden', async () => {
    api.listGoals.mockResolvedValue({ goals: [], total: 4, vision: '' })
    saveLegacy({ annual: ['Would be a duplicate'] })
    render(<GoalsTab />)
    await screen.findByText('No goals yet')
    expect(screen.queryByRole('region', { name: 'Import goals from this browser' })).toBeNull()
  })

  test('no offer when the import was already done or dismissed in this browser', async () => {
    saveLegacy({ annual: ['A goal'] })
    localStorage.setItem(IMPORT_DONE_KEY, '1')
    render(<GoalsTab />)
    await screen.findByText('No goals yet')
    expect(screen.queryByRole('region', { name: 'Import goals from this browser' })).toBeNull()
  })

  test('a failed import says so and can be retried, and is not marked done', async () => {
    api.createGoal.mockRejectedValueOnce(new Error('server is down'))
    saveLegacy({ annual: ['A goal'] })
    render(<GoalsTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 goal' }))
    await screen.findByText('server is down')
    expect(localStorage.getItem(IMPORT_DONE_KEY)).toBeNull()
    expect(screen.getByRole('button', { name: 'Import 1 goal' }).disabled).toBe(false)
  })
})

describe('GoalsTab', () => {
  test('asks for a connection instead of loading goals when there is none', () => {
    connected = false
    render(<GoalsTab />)
    expect(api.listGoals).not.toHaveBeenCalled()
  })

  test('shows goals from the server with a summary of how many need attention', async () => {
    api.listGoals.mockResolvedValue({
      goals: [serverGoal(), serverGoal({ id: 'g2', title: 'Stalled goal', progress })],
      total: 2,
      vision: 'Ship open tools.',
    })
    render(<GoalsTab />)
    await screen.findByRole('article', { name: 'Stalled goal' })
    expect(screen.getByRole('status').textContent).toBe('2 goals, 1 need attention')
    expect(screen.getByRole('region', { name: 'Vision' }).textContent).toContain('Ship open tools.')
  })

  test('Show achieved and dropped reloads the list with closed goals included', async () => {
    render(<GoalsTab />)
    await screen.findByText('No goals yet')
    expect(api.listGoals).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: 'Show achieved and dropped' }))
    await waitFor(() => expect(api.listGoals).toHaveBeenLastCalledWith(true))
    expect(screen.getByRole('button', { name: 'Hide achieved and dropped' }).getAttribute('aria-pressed')).toBe('true')
  })

  test('a load failure is shown with the server message', async () => {
    api.listGoals.mockRejectedValue(new Error('Could not reach the Command Center server.'))
    render(<GoalsTab />)
    await screen.findByText('Could not reach the Command Center server.')
  })
})

describe('GoalsTab offline', () => {
  afterEach(() => resetOfflineStatus())

  test('Add goal is disabled while the server is unreachable, and Show achieved and dropped stays enabled', async () => {
    render(<GoalsTab />)
    await screen.findByText('No goals yet')

    act(() => markOffline())

    expect(screen.getByRole('button', { name: 'Add goal' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Show achieved and dropped' }).disabled).toBe(false)
  })
})
