import { describe, test, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ProjectChip, formatDate, isOverdue } from './shared'

afterEach(() => {
  cleanup()
})

describe('formatDate', () => {
  test('a plain date is that day on the local calendar, whatever the time zone', () => {
    expect(formatDate('2026-11-01')).toBe('Nov 1')
  })

  test('a timestamp and an unreadable value', () => {
    expect(formatDate(new Date(2026, 9, 6, 15).toISOString())).toBe('Oct 6')
    expect(formatDate('soon')).toBe('soon')
    expect(formatDate(null)).toBe('')
  })
})

describe('ProjectChip', () => {
  // A narrow column shortens the name with an ellipsis (CONTRIBUTING.md, "Nothing is cut off"),
  // so the whole name stays on the chip's title.
  test('carries the whole project name in its title', () => {
    const name = 'A project name long enough to be shortened in a narrow column'
    render(<ProjectChip name={name} />)
    expect(screen.getByTitle(name).textContent).toBe(name)
  })

  test('renders nothing without a name', () => {
    const { container } = render(<ProjectChip name="" />)
    expect(container.innerHTML).toBe('')
  })
})

describe('ProjectChip in the task panel', () => {
  test('wraps a long name instead of shortening it', () => {
    const { container } = render(<ProjectChip name="A long project name" wrap />)
    expect(container.firstChild.className).toBe('project-chip is-wrapping')
  })
})

describe('isOverdue', () => {
  const now = new Date(2026, 9, 18, 10, 0) // local 18 Oct, 10:00
  test('is day-level on the local calendar: earlier today at a time is not overdue, yesterday is', () => {
    expect(isOverdue({ dueAt: '2026-10-18T06:00', status: 'open' }, now)).toBe(false)
    expect(isOverdue({ dueAt: '2026-10-17T23:59', status: 'open' }, now)).toBe(true)
    expect(isOverdue({ dueAt: '2026-10-17', status: 'done' }, now)).toBe(false)
  })

  test('reads a zoned value as its local day', () => {
    expect(isOverdue({ dueAt: new Date(2026, 9, 18, 0, 30).toISOString(), status: 'open' }, now)).toBe(false)
    expect(isOverdue({ dueAt: new Date(2026, 9, 17, 23, 30).toISOString(), status: 'open' }, now)).toBe(true)
  })
})
