import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import TaskRow from './TaskRow'
import { getDueBounds } from './dueDates'

afterEach(() => cleanup())

const DUE_BOUNDS = getDueBounds(new Date('2026-09-29T12:00:00'))
const VISIBLE_COLUMNS = [{ id: 'due' }, { id: 'project' }, { id: 'priority' }, { id: 'source' }]
const PROJECT_OPTIONS = [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }]

function baseTask(over = {}) {
  return {
    id: 't1',
    title: 'Write the report',
    status: 'open',
    priority: 'high',
    dueAt: '2026-09-29',
    projectId: 'p1',
    sourceType: 'github',
    ...over,
  }
}

function renderRow(over = {}) {
  const onToggleComplete = vi.fn()
  const onOpen = vi.fn()
  const onQuickUpdate = vi.fn()
  const task = baseTask(over.task)
  const utils = render(
    <TaskRow
      task={task}
      projectName="Alpha"
      projectOptions={PROJECT_OPTIONS}
      dueBounds={DUE_BOUNDS}
      pending={false}
      striped={false}
      open={false}
      visibleColumns={VISIBLE_COLUMNS}
      gridTemplateColumns="44px 1fr 100px 100px 100px 80px"
      phone={false}
      onToggleComplete={onToggleComplete}
      onOpen={onOpen}
      onQuickUpdate={onQuickUpdate}
      {...over.props}
    />
  )
  return { ...utils, task, onToggleComplete, onOpen, onQuickUpdate }
}

describe('TaskRow', () => {
  test('renders the title, due label, and priority', () => {
    renderRow()
    expect(screen.getByText('Write the report')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Change due date for Write the report' }).textContent).toBe('Today')
    expect(screen.getByRole('button', { name: 'Change priority for Write the report' }).textContent).toBe('High')
  })

  test('clicking the row opens the task, but clicking the complete circle does not', () => {
    const { onOpen, onToggleComplete, task } = renderRow()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete Write the report' }))
    expect(onToggleComplete).toHaveBeenCalledWith(task)
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Write the report'))
    expect(onOpen).toHaveBeenCalledWith('t1')
  })

  test('Enter on the focused row opens the task', () => {
    const { onOpen } = renderRow()
    const row = screen.getByRole('button', { name: 'Open Write the report' })
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('t1')
  })

  test('a done task shows a filled circle labelled to reopen it', () => {
    renderRow({ task: { status: 'done' } })
    const box = screen.getByRole('checkbox', { name: 'Reopen Write the report' })
    expect(box.getAttribute('aria-checked')).toBe('true')
  })

  test('the complete circle is disabled while a toggle is pending', () => {
    renderRow({ props: { pending: true } })
    expect(screen.getByRole('checkbox', { name: 'Complete Write the report' }).disabled).toBe(true)
  })

  test('picking Tomorrow from the due date menu updates the due date', () => {
    const { onQuickUpdate, task } = renderRow()
    fireEvent.click(screen.getByRole('button', { name: 'Change due date for Write the report' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Tomorrow' }))
    expect(onQuickUpdate).toHaveBeenCalledWith(task, { dueAt: DUE_BOUNDS.tomorrow })
  })

  test('picking a priority from its menu updates the priority', () => {
    const { onQuickUpdate, task } = renderRow()
    fireEvent.click(screen.getByRole('button', { name: 'Change priority for Write the report' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Low' }))
    expect(onQuickUpdate).toHaveBeenCalledWith(task, { priority: 'low' })
  })

  test('picking a project from its menu updates the project and clears the section', () => {
    const { onQuickUpdate, task } = renderRow()
    fireEvent.click(screen.getByRole('button', { name: 'Change project for Write the report' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Beta' }))
    expect(onQuickUpdate).toHaveBeenCalledWith(task, { projectId: 'p2', sectionId: null })
  })

  test('an untrusted title is shown as literal text, never as markup', () => {
    const { container } = renderRow({ task: { title: '<img src=x onerror=alert(1)>', untrustedText: true } })
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
  })
})
