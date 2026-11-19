import { describe, test, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import TaskGroupSection from './TaskGroupSection'

afterEach(cleanup)

const base = {
  groupId: 'today',
  title: 'Today',
  tasks: [],
  collapsed: true,
  onToggleCollapse: () => {},
  visibleColumns: [],
}

describe('TaskGroupSection count', () => {
  test('the header shows the plain count of the group', () => {
    render(<TaskGroupSection {...base} tasks={[{ id: 'a' }, { id: 'b' }]} />)
    expect(screen.getByText('2')).toBeTruthy()
  })
})

// A phone has no Add task row under each group (it cost a row's height per group): the same
// action is a + at the end of the group's header, and nothing else about adding changes.
describe('TaskGroupSection Add task', () => {
  const open = { ...base, collapsed: false, addRow: { dueAt: '2026-09-12' }, gridTemplateColumns: '44px 1fr' }
  const addButtons = () => screen.queryAllByRole('button', { name: 'Add task' })

  test('above a phone it is a row under the group', () => {
    let opened = 0
    const { container } = render(<TaskGroupSection {...open} phone={false} onOpenInlineAdd={() => { opened += 1 }} />)
    expect(addButtons().length).toBe(1)
    expect(container.querySelector('.mytasks-add-row')).toBe(addButtons()[0])
    expect(container.querySelector('.mytasks-section-header').contains(addButtons()[0])).toBe(false)
    addButtons()[0].click()
    expect(opened).toBe(1)
  })

  test('on a phone it is one button in the header, and there is no row', () => {
    let opened = 0
    const { container } = render(<TaskGroupSection {...open} phone onOpenInlineAdd={() => { opened += 1 }} />)
    expect(addButtons().length).toBe(1)
    expect(container.querySelector('.mytasks-add-row')).toBe(null)
    expect(container.querySelector('.mytasks-section-header').contains(addButtons()[0])).toBe(true)
    addButtons()[0].click()
    expect(opened).toBe(1)
  })

  test('a group with no Add task (Overdue) and a collapsed group have none on a phone either', () => {
    render(<TaskGroupSection {...open} phone addRow={null} />)
    expect(addButtons().length).toBe(0)
    cleanup()
    render(<TaskGroupSection {...open} phone collapsed />)
    expect(addButtons().length).toBe(0)
  })
})
