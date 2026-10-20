import { describe, test, expect, afterEach, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import TaskListToolbar from './TaskListToolbar'
import { useViewState } from './viewState'

afterEach(() => cleanup())
beforeEach(() => localStorage.clear())

const PROJECTS = [{ id: 'p1', name: 'Polaris' }]
const GOALS = [{ id: 'g1', title: 'Ship it' }]
const TASKS = [{ id: 't1', title: 'One', sourceType: null, assignee: 'scribe' }]

// The toolbar on the real view state, so a choice shows on the buttons as it does on My tasks.
function Host() {
  const { view, setSort, setGroup, toggleFilter, clearFilters, resetSort } = useViewState()
  return (
    <TaskListToolbar
      onAddTask={() => {}}
      projects={PROJECTS}
      goals={GOALS}
      goalsLoaded
      tasks={TASKS}
      view={view}
      onSetSort={setSort}
      onResetSort={resetSort}
      onSetGroup={setGroup}
      onToggleFilter={toggleFilter}
      onClearFilters={clearFilters}
      hiddenColumns={{}}
      onSetColumnHidden={() => {}}
    />
  )
}

describe('TaskListToolbar', () => {
  test('at rest the buttons read Filter, Sort, and Group, with nothing to clear', () => {
    render(<Host />)
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sort' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Group' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset sort' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset grouping' })).toBeNull()
  })

  test('Sort is one field select and a direction select, named on the button, and Reset sort clears it', async () => {
    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }))
    const pop = screen.getByRole('dialog', { name: 'Sort tasks' })
    const field = within(pop).getByRole('combobox', { name: 'Sort by' })
    await waitFor(() => expect(document.activeElement).toBe(field))
    expect(within(pop).getAllByRole('option').map((o) => o.textContent)).toEqual(['Due date', 'Priority', 'Project', 'Name', 'Ascending', 'Descending'])
    expect(within(pop).getByRole('button', { name: 'Reset' }).disabled).toBe(true)

    fireEvent.change(field, { target: { value: 'priority' } })
    fireEvent.change(within(pop).getByRole('combobox', { name: 'Direction' }), { target: { value: 'desc' } })
    expect(screen.getByRole('button', { name: 'Sort: Priority, descending' }).textContent).toContain('Sort: Priority')
    expect(JSON.parse(localStorage.getItem('cc-mytasks-view-v1')).sort).toEqual({ field: 'priority', dir: 'desc' })

    fireEvent.click(screen.getByRole('button', { name: 'Reset sort' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Sort' }))
    expect(screen.queryByRole('button', { name: 'Reset sort' })).toBeNull()
  })

  test('Group is one select, named on the button when it is not by due date', () => {
    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: 'Group' }))
    const pop = screen.getByRole('dialog', { name: 'Group tasks' })
    fireEvent.change(within(pop).getByRole('combobox', { name: 'Group by' }), { target: { value: 'project' } })
    expect(screen.getByRole('button', { name: 'Group: Project' })).toBeTruthy()
    fireEvent.click(within(pop).getByRole('button', { name: 'Reset' }))
    expect(screen.getByRole('button', { name: 'Group' })).toBeTruthy()
    expect(within(pop).getByRole('combobox', { name: 'Group by' }).value).toBe('due')
  })

  test('Filter has Readiness and Priority as chips and the long groups as rows, and counts what is chosen', () => {
    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }))
    const pop = screen.getByRole('dialog', { name: 'Filter tasks' })
    const readiness = within(pop).getByRole('group', { name: 'Readiness' })
    expect(within(readiness).getAllByRole('button').map((b) => b.textContent)).toEqual(['Ready', 'Blocked'])
    const priority = within(pop).getByRole('group', { name: 'Priority' })
    expect(within(priority).getAllByRole('button').map((b) => b.textContent)).toEqual(['Urgent', 'High', 'Medium', 'Low', 'No priority'])

    fireEvent.click(within(priority).getByRole('button', { name: 'Urgent' }))
    expect(within(priority).getByRole('button', { name: 'Urgent' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(within(pop).getByRole('button', { name: 'Project, any' }))
    fireEvent.click(within(pop).getByRole('checkbox', { name: 'Polaris' }))
    expect(within(pop).getByRole('button', { name: 'Project, 1 selected' }).getAttribute('aria-expanded')).toBe('true')
    // Every long group is still reachable.
    for (const name of ['Goal, any', 'Source, any', 'Assignee, any']) expect(within(pop).getByRole('button', { name })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Filter: 2' })).toBeTruthy()

    // The popover's Clear clears everything and leaves focus in the popover.
    fireEvent.click(within(pop).getByRole('button', { name: 'Clear' }))
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy()
    expect(document.activeElement).toBe(within(readiness).getByRole('button', { name: 'Ready' }))
  })

  test('a reopened Filter opens the groups that have something chosen', () => {
    localStorage.setItem('cc-mytasks-view-v1', JSON.stringify({ sort: { field: 'due', dir: 'asc' }, group: 'due', filters: { goalIds: ['g1'] } }))
    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: 'Filter: 1' }))
    const pop = screen.getByRole('dialog', { name: 'Filter tasks' })
    expect(within(pop).getByRole('button', { name: 'Goal, 1 selected' }).getAttribute('aria-expanded')).toBe('true')
    expect(within(pop).getByRole('checkbox', { name: 'Ship it' }).getAttribute('aria-checked')).toBe('true')
    expect(within(pop).getByRole('button', { name: 'Project, any' }).getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Filter' }))
  })
})
