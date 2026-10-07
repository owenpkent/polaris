import { describe, test, expect } from 'vitest'
import { formatDate } from './shared'

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
