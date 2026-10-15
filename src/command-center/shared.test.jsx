import { describe, test, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ProjectChip, formatDate } from './shared'

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
