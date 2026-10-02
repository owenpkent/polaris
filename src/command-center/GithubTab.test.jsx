import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import GithubTab from './GithubTab'
import { markOffline, resetOfflineStatus } from './offlineStatus'

const api = {}
let connected = true

vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected, api }) }))

const signedInStatus = (over = {}) => ({
  mode: 'app',
  app: { slug: 'cc', name: 'Polaris Command Center', htmlUrl: 'https://github.com/apps/cc', installUrl: 'https://github.com/apps/cc/installations/new' },
  user: { login: 'owenpkent' },
  signedIn: true,
  refreshExpiresAt: null,
  installations: [{ id: 1, account: { login: 'owenpkent', type: 'User' }, repositorySelection: 'all', manageUrl: 'https://github.com/settings/installations/1' }],
})

const repo = (over = {}) => ({
  fullName: 'owenpkent/Octavium', private: true, tracked: false, project: null, syncIssues: true, readChecklists: true, ...over,
})

beforeEach(() => {
  connected = true
  Object.assign(api, {
    githubStatus: vi.fn().mockResolvedValue(signedInStatus()),
    githubRepos: vi.fn().mockResolvedValue({ repos: [] }),
    updateGithubRepo: vi.fn().mockResolvedValue({ repo: repo() }),
  })
})

afterEach(() => cleanup())

describe('GithubTab', () => {
  test('asks for a connection instead of loading status when there is none', () => {
    connected = false
    render(<GithubTab />)
    expect(api.githubStatus).not.toHaveBeenCalled()
  })

  test('shows the intro sentence about Track as project near the repo list', async () => {
    api.githubRepos.mockResolvedValue({ repos: [repo()] })
    render(<GithubTab />)
    await screen.findByText('owenpkent/Octavium')
    expect(
      screen.getByText('A repo becomes a project when you switch on Track as project. Switching it off archives the project and keeps its tasks.')
    ).toBeTruthy()
  })

  test('an untracked repo has its sync switches disabled with a hint, and Track as project is off', async () => {
    api.githubRepos.mockResolvedValue({ repos: [repo({ tracked: false, project: null })] })
    render(<GithubTab />)
    await screen.findByText('owenpkent/Octavium')

    const track = screen.getByRole('switch', { name: 'Track owenpkent/Octavium as a project' })
    expect(track.getAttribute('aria-checked')).toBe('false')

    const sync = screen.getByRole('switch', { name: 'Sync issues and PRs for owenpkent/Octavium' })
    const checklists = screen.getByRole('switch', { name: 'Read checklists for owenpkent/Octavium' })
    expect(sync.disabled).toBe(true)
    expect(checklists.disabled).toBe(true)

    expect(screen.getByText('Sync issues and read checklists apply once owenpkent/Octavium is tracked as a project.')).toBeTruthy()
  })

  test('a tracked repo shows the linked project name and enabled sync switches', async () => {
    api.githubRepos.mockResolvedValue({ repos: [repo({ tracked: true, project: { slug: 'octavium', name: 'Octavium' } })] })
    render(<GithubTab />)
    await screen.findByText('owenpkent/Octavium')

    expect(screen.getByText('Octavium')).toBeTruthy()
    const track = screen.getByRole('switch', { name: 'Track owenpkent/Octavium as a project' })
    expect(track.getAttribute('aria-checked')).toBe('true')

    const sync = screen.getByRole('switch', { name: 'Sync issues and PRs for owenpkent/Octavium' })
    const checklists = screen.getByRole('switch', { name: 'Read checklists for owenpkent/Octavium' })
    expect(sync.disabled).toBe(false)
    expect(checklists.disabled).toBe(false)
    expect(screen.queryByText('Sync issues and read checklists apply once owenpkent/Octavium is tracked as a project.')).toBeNull()
  })

  test('switching on Track as project PATCHes tracked:true and reflects the returned project', async () => {
    api.githubRepos.mockResolvedValue({ repos: [repo({ tracked: false, project: null })] })
    api.updateGithubRepo.mockResolvedValue({
      repo: { fullName: 'owenpkent/Octavium', tracked: true, project: { slug: 'octavium', name: 'Octavium' }, syncIssues: true, readChecklists: true },
    })
    render(<GithubTab />)
    await screen.findByText('owenpkent/Octavium')

    fireEvent.click(screen.getByRole('switch', { name: 'Track owenpkent/Octavium as a project' }))

    await waitFor(() => expect(api.updateGithubRepo).toHaveBeenCalledWith('owenpkent/Octavium', { tracked: true }))
    await screen.findByText('Octavium')
    const sync = await screen.findByRole('switch', { name: 'Sync issues and PRs for owenpkent/Octavium' })
    expect(sync.disabled).toBe(false)
  })

  test('a failed toggle reverts the switch and shows the row error', async () => {
    api.githubRepos.mockResolvedValue({ repos: [repo({ tracked: false, project: null })] })
    api.updateGithubRepo.mockRejectedValue(new Error('could not reach github'))
    render(<GithubTab />)
    await screen.findByText('owenpkent/Octavium')

    const track = screen.getByRole('switch', { name: 'Track owenpkent/Octavium as a project' })
    fireEvent.click(track)

    await screen.findByText('could not reach github')
    expect(track.getAttribute('aria-checked')).toBe('false')
  })
})

describe('GithubTab offline', () => {
  afterEach(() => resetOfflineStatus())

  test('the Track switch is disabled while the server is unreachable, and Refresh stays enabled', async () => {
    api.githubRepos.mockResolvedValue({ repos: [repo({ tracked: false, project: null })] })
    render(<GithubTab />)
    await screen.findByText('owenpkent/Octavium')

    act(() => markOffline())

    const track = screen.getByRole('switch', { name: 'Track owenpkent/Octavium as a project' })
    expect(track.disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Refresh' }).disabled).toBe(false)
  })
})
