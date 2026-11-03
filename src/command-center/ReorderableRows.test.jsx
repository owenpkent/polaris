import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ReorderableRows, { ReorderScope } from './ReorderableRows'
import ReorderHandle from './ReorderHandle'

afterEach(cleanup)

const TASKS = [
  { id: 'a', title: 'Alpha', position: 1 },
  { id: 'b', title: 'Beta', position: 2 },
  { id: 'c', title: 'Gamma', position: 3 },
]

// Rows laid out 44px apart, since jsdom draws nothing.
function layRows() {
  screen.getAllByTestId('row').forEach((el, i) => {
    el.getBoundingClientRect = () => ({ top: i * 44, height: 44, bottom: i * 44 + 44, left: 0, right: 500, width: 500 })
  })
}

function renderRows({ enabled = true, onReorder = vi.fn() } = {}) {
  render(
    <ReorderableRows tasks={TASKS} enabled={enabled} onReorder={onReorder}>
      {(task, reorder, rowClass) => (
        <div key={task.id} data-testid="row" data-task-id={task.id} className={`row${rowClass}`}>
          {reorder ? <ReorderHandle task={task} reorder={reorder} /> : null}
          {task.title}
        </div>
      )}
    </ReorderableRows>
  )
  return { onReorder }
}

describe('ReorderableRows', () => {
  test('without the manual sort there are no handles', () => {
    renderRows({ enabled: false })
    expect(screen.queryByRole('button', { name: /^Reorder/ })).toBeNull()
  })

  test('dragging a handle marks the slot under the pointer and drops the row there', () => {
    const { onReorder } = renderRows()
    layRows()
    const handle = screen.getByRole('button', { name: 'Reorder Alpha' })
    fireEvent.pointerDown(handle, { isPrimary: true, button: 0, pointerId: 1, clientY: 20 })
    // A press that moves less than the threshold is not a drag.
    fireEvent.pointerMove(handle, { clientY: 22 })
    expect(screen.getAllByTestId('row').map((el) => el.className)).toEqual(['row', 'row', 'row'])
    fireEvent.pointerMove(handle, { clientY: 120 })
    expect(screen.getAllByTestId('row').map((el) => el.className)).toEqual(['row is-dragging', 'row', 'row is-drop-after'])
    expect(document.body.classList.contains('is-reordering')).toBe(true)
    fireEvent.pointerUp(handle, { clientY: 120 })
    expect(onReorder).toHaveBeenCalledWith({ updates: [{ id: 'a', position: 4 }], order: ['b', 'c', 'a'], index: 2 })
    expect(document.body.classList.contains('is-reordering')).toBe(false)
    expect(screen.getByRole('status').textContent).toBe('Alpha moved to 3 of 3')
    // The click that ends the press does not open the menu.
    fireEvent.click(handle)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('Escape drops the row where it was', () => {
    const { onReorder } = renderRows()
    layRows()
    const handle = screen.getByRole('button', { name: 'Reorder Alpha' })
    fireEvent.pointerDown(handle, { isPrimary: true, button: 0, pointerId: 1, clientY: 20 })
    fireEvent.pointerMove(handle, { clientY: 120 })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getAllByTestId('row').map((el) => el.className)).toEqual(['row', 'row', 'row'])
    fireEvent.pointerUp(handle, { clientY: 120 })
    expect(onReorder).not.toHaveBeenCalled()
  })

  test('a drop in the slot the row already fills changes nothing', () => {
    const { onReorder } = renderRows()
    layRows()
    const handle = screen.getByRole('button', { name: 'Reorder Beta' })
    fireEvent.pointerDown(handle, { isPrimary: true, button: 0, pointerId: 1, clientY: 60 })
    fireEvent.pointerMove(handle, { clientY: 75 })
    expect(screen.getAllByTestId('row').map((el) => el.className)).toEqual(['row', 'row is-dragging', 'row'])
    fireEvent.pointerUp(handle, { clientY: 75 })
    expect(onReorder).not.toHaveBeenCalled()
  })

  test('a click opens the menu, whose moves send the plan, and the arrow keys move one step', () => {
    const { onReorder } = renderRows()
    const handle = screen.getByRole('button', { name: 'Reorder Beta' })
    fireEvent.click(handle)
    const menu = screen.getByRole('menu', { name: 'Reorder Beta' })
    expect(Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => [el.textContent, el.disabled])).toEqual([
      ['Move up', false], ['Move down', false], ['Move to top', false], ['Move to bottom', false],
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to top' }))
    expect(onReorder).toHaveBeenLastCalledWith({ updates: [{ id: 'b', position: 0 }], order: ['b', 'a', 'c'], index: 0 })
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(onReorder).toHaveBeenLastCalledWith({ updates: [{ id: 'b', position: 4 }], order: ['a', 'c', 'b'], index: 2 })
    expect(screen.getByRole('status').textContent).toBe('Beta moved to 3 of 3')
  })

  test('the first row cannot move up and the last cannot move down', () => {
    const { onReorder } = renderRows()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Alpha' }), { key: 'ArrowUp' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Gamma' }), { key: 'ArrowDown' })
    expect(onReorder).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reorder Gamma' }))
    expect(screen.getByRole('menuitem', { name: 'Move down' }).disabled).toBe(true)
    expect(screen.getByRole('menuitem', { name: 'Move to bottom' }).disabled).toBe(true)
    expect(screen.getByRole('menuitem', { name: 'Move up' }).disabled).toBe(false)
  })
})

describe('ReorderScope across groups', () => {
  const OLD = [{ id: 'o', title: 'Old', position: 0 }]
  const NOW = [{ id: 'a', title: 'Alpha', position: 1 }]
  const GROUPS = [
    { id: 'overdue', label: 'Overdue', tasks: OLD, closed: true },
    { id: 'today', label: 'Today', tasks: NOW, closed: false },
  ]

  // Overdue spans 0 to 88 (header 0 to 44, its row 44 to 88), Today 88 to 176 (its row 132 to 176).
  function renderGroups(onMoveAcross) {
    const row = (task, reorder, rowClass) => (
      <div key={task.id} data-testid="row" data-task-id={task.id} className={`row${rowClass}`}>
        <ReorderHandle task={task} reorder={reorder} />
        {task.title}
      </div>
    )
    render(
      <ReorderScope enabled crossGroup groups={GROUPS} onReorder={vi.fn()} onMoveAcross={onMoveAcross}>
        {GROUPS.map((g) => (
          <section key={g.id} data-reorder-group={g.id} data-testid={`group-${g.id}`}>
            <h2 data-reorder-header data-testid={`header-${g.id}`}>{g.label}</h2>
            <ReorderableRows groupId={g.id} tasks={g.tasks} enabled>{row}</ReorderableRows>
          </section>
        ))}
      </ReorderScope>
    )
    const rect = (top, bottom) => () => ({ top, bottom, height: bottom - top, left: 0, right: 500, width: 500 })
    screen.getByTestId('group-overdue').getBoundingClientRect = rect(0, 88)
    screen.getByTestId('header-overdue').getBoundingClientRect = rect(0, 44)
    screen.getByTestId('group-today').getBoundingClientRect = rect(88, 176)
    screen.getByTestId('header-today').getBoundingClientRect = rect(88, 132)
    const [old, now] = screen.getAllByTestId('row')
    old.getBoundingClientRect = rect(44, 88)
    now.getBoundingClientRect = rect(132, 176)
  }

  test('a row dragged over a closed group lands at the top of the open group below', () => {
    const onMoveAcross = vi.fn()
    renderGroups(onMoveAcross)
    const handle = screen.getByRole('button', { name: 'Reorder Alpha' })
    fireEvent.pointerDown(handle, { isPrimary: true, button: 0, pointerId: 1, clientY: 150 })
    fireEvent.pointerMove(handle, { clientY: 80 })
    // Over Overdue's row, which wears no drop mark: the drop is the top of Today, where Alpha is.
    expect(screen.getAllByTestId('row').map((el) => el.className)).toEqual(['row', 'row is-dragging'])
    fireEvent.pointerUp(handle, { clientY: 80 })
    expect(onMoveAcross).not.toHaveBeenCalled()
  })

  test('a row in a closed group can be dragged out of it', () => {
    const onMoveAcross = vi.fn()
    renderGroups(onMoveAcross)
    const handle = screen.getByRole('button', { name: 'Reorder Old' })
    fireEvent.pointerDown(handle, { isPrimary: true, button: 0, pointerId: 1, clientY: 60 })
    fireEvent.pointerMove(handle, { clientY: 170 })
    fireEvent.pointerUp(handle, { clientY: 170 })
    expect(onMoveAcross).toHaveBeenCalledWith({ task: OLD[0], fromId: 'overdue', toId: 'today', slot: 1 })
  })

  test('the arrow keys never move a row into a closed group', () => {
    const onMoveAcross = vi.fn()
    renderGroups(onMoveAcross)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Alpha' }), { key: 'ArrowUp' })
    expect(onMoveAcross).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Old' }), { key: 'ArrowDown' })
    expect(onMoveAcross).toHaveBeenCalledWith({ task: OLD[0], fromId: 'overdue', toId: 'today', slot: 0 })
  })
})
