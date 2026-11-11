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
