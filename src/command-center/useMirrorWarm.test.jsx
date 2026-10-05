import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

// The warm pass has to ask for everything a tab reads, or that tab is empty offline on a device
// that never opened it (CONTRIBUTING.md, Offline). This pins the calls that are easy to forget.

const connection = { connected: true, baseUrl: 'http://x', api: null }
vi.mock('./ConnectionContext', () => ({ useConnection: () => connection }))
vi.mock('./useEvents', () => ({ useEventRefresh: () => {} }))

const { useMirrorWarm } = await import('./useMirrorWarm')

function fakeApi() {
  const empty = async () => ({})
  return {
    listProjects: vi.fn(async () => ({ projects: [] })),
    listTasks: vi.fn(async () => ({ tasks: [] })),
    listGoals: vi.fn(async () => ({ goals: [] })),
    listInbox: vi.fn(empty),
    listRules: vi.fn(empty),
    getView: vi.fn(empty),
    getDigest: vi.fn(empty),
    getSync: vi.fn(empty),
    githubStatus: vi.fn(empty),
    githubRepos: vi.fn(empty),
    getThreads: vi.fn(empty),
    getEvents: vi.fn(async () => ({ events: [], headId: 1 })),
    getProject: vi.fn(empty),
    getGoal: vi.fn(empty),
    getTask: vi.fn(empty),
  }
}

function Warmer() {
  useMirrorWarm()
  return null
}

afterEach(() => cleanup())

describe('useMirrorWarm', () => {
  test('on connect it fetches both Threads filters, without the Threads tab being mounted', async () => {
    connection.api = fakeApi()
    render(<Warmer />)
    await waitFor(() => expect(connection.api.getThreads).toHaveBeenCalledTimes(2))
    expect(connection.api.getThreads).toHaveBeenCalledWith('open')
    expect(connection.api.getThreads).toHaveBeenCalledWith('closed')
    // The rest of the list is still asked for.
    expect(connection.api.listInbox).toHaveBeenCalled()
    expect(connection.api.listRules).toHaveBeenCalled()
  })
})
