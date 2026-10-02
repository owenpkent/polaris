import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ProjectsTab from './ProjectsTab'
import { markOffline, resetOfflineStatus } from './offlineStatus'

const api = {}
let connected = true

vi.mock('./ConnectionContext', () => ({ useConnection: () => ({ connected, api }) }))
vi.mock('./useEvents', () => ({ useEventRefresh: () => {} }))

const serverProject = (over = {}) => ({
  id: 'p1', slug: 'existing-project', name: 'Existing project', category: null,
  type: 'Software', status: 'Active', description: null, path: null, github: null,
  archived: false, meta: {}, counts: { open: 2, inbox: 0, overdue: 0, done: 1 }, ...over,
})

beforeEach(() => {
  connected = true
  Object.assign(api, {
    listProjects: vi.fn().mockResolvedValue({ projects: [] }),
    createProject: vi.fn().mockResolvedValue({ project: serverProject() }),
    updateProject: vi.fn().mockResolvedValue({ project: serverProject() }),
  })
})

afterEach(() => cleanup())

describe('ProjectsTab', () => {
  test('asks for a connection instead of loading projects when there is none', () => {
    connected = false
    render(<ProjectsTab />)
    expect(api.listProjects).not.toHaveBeenCalled()
  })

  test('lists projects with type, status, the GitHub repo (or "No repo"), and the open task count', async () => {
    api.listProjects.mockResolvedValue({
      projects: [
        serverProject({ id: 'p1', name: 'No repo project', github: null, counts: { open: 3, inbox: 0, overdue: 0, done: 0 } }),
        serverProject({ id: 'p2', name: 'Repo project', github: 'https://github.com/owner/repo', counts: { open: 1, inbox: 0, overdue: 0, done: 0 } }),
      ],
    })
    render(<ProjectsTab />)
    const row1 = await screen.findByRole('article', { name: 'No repo project' })
    expect(row1.textContent).toContain('Software')
    expect(row1.textContent).toContain('Active')
    expect(row1.textContent).toContain('No repo')
    expect(row1.textContent).toContain('3 open tasks')
    const row2 = screen.getByRole('article', { name: 'Repo project' })
    expect(row2.textContent).toContain('owner/repo')
    expect(row2.textContent).toContain('1 open task')
  })

  test('create sends the right body and shows the new project', async () => {
    api.listProjects.mockResolvedValueOnce({ projects: [] })
    api.createProject.mockResolvedValue({ project: serverProject({ id: 'new', name: 'Camping trip', type: 'Personal' }) })
    render(<ProjectsTab />)
    await screen.findByText('No projects yet')

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    const form = screen.getByRole('form', { name: 'New project' })
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Camping trip' } })
    fireEvent.change(within(form).getByLabelText('Type'), { target: { value: 'Personal' } })

    api.listProjects.mockResolvedValueOnce({ projects: [serverProject({ id: 'new', name: 'Camping trip', type: 'Personal' })] })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({ name: 'Camping trip', type: 'Personal' }))
    await screen.findByRole('article', { name: 'Camping trip' })
    expect(screen.queryByRole('form', { name: 'New project' })).toBeNull()
  })

  test('edit sends only the changed fields, with null for an emptied field', async () => {
    const project = serverProject({ type: 'Software', status: 'Active', github: 'https://github.com/owner/repo' })
    api.listProjects.mockResolvedValue({ projects: [project] })
    render(<ProjectsTab />)
    await screen.findByRole('article', { name: 'Existing project' })

    fireEvent.click(screen.getByRole('button', { name: 'Edit Existing project' }))
    const form = screen.getByRole('form', { name: 'Edit Existing project' })
    fireEvent.change(within(form).getByLabelText('Status'), { target: { value: 'Paused' } })
    fireEvent.change(within(form).getByLabelText('GitHub repo'), { target: { value: '' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('p1', { status: 'Paused', github: null }))
  })

  test('a save with nothing changed just closes the panel without calling the server', async () => {
    const project = serverProject()
    api.listProjects.mockResolvedValue({ projects: [project] })
    render(<ProjectsTab />)
    await screen.findByRole('article', { name: 'Existing project' })

    fireEvent.click(screen.getByRole('button', { name: 'Edit Existing project' }))
    const form = screen.getByRole('form', { name: 'Edit Existing project' })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit Existing project' })).toBeNull())
    expect(api.updateProject).not.toHaveBeenCalled()
  })

  test('Archive updates the project and closes the panel', async () => {
    const project = serverProject({ archived: false })
    api.listProjects.mockResolvedValue({ projects: [project] })
    api.updateProject.mockResolvedValue({ project: { ...project, archived: true } })
    render(<ProjectsTab />)
    await screen.findByRole('article', { name: 'Existing project' })

    fireEvent.click(screen.getByRole('button', { name: 'Edit Existing project' }))
    const form = screen.getByRole('form', { name: 'Edit Existing project' })
    fireEvent.click(within(form).getByRole('button', { name: 'Archive' }))

    await waitFor(() => expect(api.updateProject).toHaveBeenCalledWith('p1', { archived: true }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit Existing project' })).toBeNull())
  })

  test('a server error is shown in the panel with role alert, and the panel stays open with the typed values kept', async () => {
    api.listProjects.mockResolvedValue({ projects: [] })
    api.createProject.mockRejectedValue(new Error('a project with the slug "dup" already exists'))
    render(<ProjectsTab />)
    await screen.findByText('No projects yet')

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    const form = screen.getByRole('form', { name: 'New project' })
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Dup name' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))

    await screen.findByText('a project with the slug "dup" already exists')
    expect(screen.getByRole('alert').textContent).toBe('a project with the slug "dup" already exists')
    const stillOpenForm = screen.getByRole('form', { name: 'New project' })
    expect(within(stillOpenForm).getByLabelText('Name').value).toBe('Dup name')
  })

  test('Esc closes the New project panel and returns focus to the button that opened it', async () => {
    api.listProjects.mockResolvedValue({ projects: [] })
    render(<ProjectsTab />)
    await screen.findByText('No projects yet')

    const newButton = screen.getByRole('button', { name: 'New project' })
    fireEvent.click(newButton)
    const form = screen.getByRole('form', { name: 'New project' })
    fireEvent.keyDown(form, { key: 'Escape' })

    expect(screen.queryByRole('form', { name: 'New project' })).toBeNull()
    expect(document.activeElement).toBe(newButton)
  })

  test('Esc closes an Edit panel and returns focus to that row\'s Edit button', async () => {
    const project = serverProject()
    api.listProjects.mockResolvedValue({ projects: [project] })
    render(<ProjectsTab />)
    await screen.findByRole('article', { name: 'Existing project' })

    const editButton = screen.getByRole('button', { name: 'Edit Existing project' })
    fireEvent.click(editButton)
    const form = screen.getByRole('form', { name: 'Edit Existing project' })
    fireEvent.keyDown(form, { key: 'Escape' })

    expect(screen.queryByRole('form', { name: 'Edit Existing project' })).toBeNull()
    expect(document.activeElement).toBe(editButton)
  })

  test('Name and GitHub repo are editable even on an old row that still carries meta.registryPath', async () => {
    const project = serverProject({ meta: { registryPath: 'C:\\Users\\Sam\\dev\\Sample-App' } })
    api.listProjects.mockResolvedValue({ projects: [project] })
    render(<ProjectsTab />)
    await screen.findByRole('article', { name: 'Existing project' })

    fireEvent.click(screen.getByRole('button', { name: 'Edit Existing project' }))
    const form = screen.getByRole('form', { name: 'Edit Existing project' })
    expect(within(form).getByLabelText('Name').disabled).toBe(false)
    expect(within(form).getByLabelText('GitHub repo').disabled).toBe(false)
    expect(within(form).queryByText('Set in projects.yaml')).toBeNull()
  })

  test('Show archived toggles the query and marks an archived project in the list', async () => {
    render(<ProjectsTab />)
    await screen.findByText('No projects yet')
    expect(api.listProjects).toHaveBeenLastCalledWith({ includeArchived: false })

    api.listProjects.mockResolvedValue({ projects: [serverProject({ archived: true })] })
    fireEvent.click(screen.getByRole('button', { name: 'Show archived' }))
    await waitFor(() => expect(api.listProjects).toHaveBeenLastCalledWith({ includeArchived: true }))
    const row = await screen.findByRole('article', { name: 'Existing project' })
    expect(row.textContent).toContain('Archived')
    expect(screen.getByRole('button', { name: 'Hide archived' }).getAttribute('aria-pressed')).toBe('true')
  })

  test('a load failure is shown with the server message', async () => {
    api.listProjects.mockRejectedValue(new Error('Could not reach the Command Center server.'))
    render(<ProjectsTab />)
    await screen.findByText('Could not reach the Command Center server.')
  })
})

describe('ProjectsTab offline', () => {
  afterEach(() => resetOfflineStatus())

  test('New project is disabled while the server is unreachable, and Show archived stays enabled', async () => {
    render(<ProjectsTab />)
    await screen.findByText('No projects yet')

    act(() => markOffline())

    expect(screen.getByRole('button', { name: 'New project' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Show archived' }).disabled).toBe(false)
  })
})
