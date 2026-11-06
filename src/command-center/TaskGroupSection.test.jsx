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

function header(tasks, progress) {
  return render(<TaskGroupSection {...base} tasks={tasks} progress={progress} />)
}

describe('TaskGroupSection progress', () => {
  test('a group without progress shows its plain count', () => {
    header([{ id: 'a' }, { id: 'b' }], null)
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText('All clear')).toBeNull()
  })

  test('with tasks left and none done it reads "n left" and has no bar', () => {
    header([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { done: 0 })
    expect(screen.getByText('3 left')).toBeTruthy()
    expect(screen.queryByText(/ done$/)).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  test('with some done it adds "m done", and never a bar', () => {
    header([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { done: 1 })
    expect(screen.getByText('3 left')).toBeTruthy()
    expect(screen.getByText('1 done')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  test('with nothing left it says All clear and the count reads 0', () => {
    const { container } = header([], { done: 2 })
    expect(screen.getByText('All clear')).toBeTruthy()
    expect(screen.getByText('0')).toBeTruthy()
    expect(screen.getByText('2 done')).toBeTruthy()
    expect(container.querySelector('svg.lucide-check').getAttribute('aria-hidden')).toBe('true')
  })

  test('an empty Today with nothing done says All clear and has no bar', () => {
    header([], { done: 0 })
    expect(screen.getByText('All clear')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })
})
