import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import MonthCalendar from './MonthCalendar'

afterEach(cleanup)

const days = () => Array.from(document.querySelectorAll('[data-date]'))
const dayButton = (iso) => document.querySelector(`[data-date="${iso}"]`)

function setup(props = {}) {
  const onPick = vi.fn()
  render(<MonthCalendar value="2026-10-14" today="2026-10-17" onPick={onPick} {...props} />)
  return onPick
}

describe('MonthCalendar', () => {
  test('shows the month of the value', () => {
    setup()
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeTruthy()
    expect(days()).toHaveLength(31)
  })

  test('shows the month of today when there is no value', () => {
    setup({ value: null, today: '2026-11-03' })
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeTruthy()
    expect(days()).toHaveLength(30)
  })

  test('marks the value pressed and today as the current date', () => {
    setup()
    expect(dayButton('2026-10-14').getAttribute('aria-pressed')).toBe('true')
    expect(dayButton('2026-10-15').getAttribute('aria-pressed')).toBe('false')
    expect(dayButton('2026-10-17').getAttribute('aria-current')).toBe('date')
    expect(dayButton('2026-10-14').getAttribute('aria-current')).toBeNull()
  })

  test('only one day is in the tab order', () => {
    setup()
    const tabbable = days().filter((b) => b.tabIndex === 0)
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0].dataset.date).toBe('2026-10-14')
  })

  test('clicking a day picks it', () => {
    const onPick = setup()
    fireEvent.click(dayButton('2026-10-20'))
    expect(onPick).toHaveBeenCalledWith('2026-10-20')
  })

  test('arrow keys move focus by a day and a week', () => {
    setup()
    dayButton('2026-10-14').focus()
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' })
    expect(document.activeElement.dataset.date).toBe('2026-10-15')
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' })
    expect(document.activeElement.dataset.date).toBe('2026-10-22')
    fireEvent.keyDown(document.activeElement, { key: 'ArrowLeft' })
    expect(document.activeElement.dataset.date).toBe('2026-10-21')
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' })
    expect(document.activeElement.dataset.date).toBe('2026-10-14')
  })

  test('Home and End go to the ends of the week (Monday first)', () => {
    setup()
    dayButton('2026-10-14').focus()
    fireEvent.keyDown(document.activeElement, { key: 'Home' })
    expect(document.activeElement.dataset.date).toBe('2026-10-12')
    fireEvent.keyDown(document.activeElement, { key: 'End' })
    expect(document.activeElement.dataset.date).toBe('2026-10-18')
  })

  test('PageDown moves a month and PageUp back', () => {
    setup()
    dayButton('2026-10-14').focus()
    fireEvent.keyDown(document.activeElement, { key: 'PageDown' })
    expect(document.activeElement.dataset.date).toBe('2026-11-14')
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeTruthy()
    fireEvent.keyDown(document.activeElement, { key: 'PageUp' })
    expect(document.activeElement.dataset.date).toBe('2026-10-14')
  })

  test('moving past the month end shows the next month', () => {
    setup({ value: '2026-10-31' })
    dayButton('2026-10-31').focus()
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' })
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeTruthy()
    expect(document.activeElement.dataset.date).toBe('2026-11-01')
  })

  test('Previous and Next month buttons change the heading', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeTruthy()
  })

  test('next month clamps the day (Oct 31 to Nov 30)', () => {
    setup({ value: '2026-10-31' })
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(days().find((b) => b.tabIndex === 0).dataset.date).toBe('2026-11-30')
  })
})
