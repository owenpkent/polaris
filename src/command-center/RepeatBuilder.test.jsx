import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import RepeatBuilder, { RepeatSelect, previewText } from './RepeatBuilder'

afterEach(cleanup)

// 2026-10-14 is a Wednesday.
const DUE = '2026-10-14'

// A controlled host, as the real callers are.
function Host({ initial = 'weekly', onChange, api, Component = RepeatBuilder }) {
  const [value, setValue] = useState(initial)
  return (
    <Component
      value={value}
      dueIso={DUE}
      api={api}
      onChange={(v) => { setValue(v); onChange?.(v) }}
    />
  )
}

describe('RepeatBuilder', () => {
  test('More and Fewer step the interval', () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(onChange).toHaveBeenLastCalledWith('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE')
    expect(screen.getByRole('button', { name: 'Fewer' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Fewer' }))
    expect(onChange).toHaveBeenLastCalledWith('FREQ=WEEKLY;BYDAY=WE')
  })

  test('Fewer is disabled at 1', () => {
    render(<Host />)
    expect(screen.getByRole('button', { name: 'Fewer' }).disabled).toBe(true)
  })

  test('month unit shows the day of the month, and Last day gives BYMONTHDAY=-1', () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat unit' }), { target: { value: 'month' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=MONTHLY;BYMONTHDAY=14')
    fireEvent.change(screen.getByRole('combobox', { name: 'Day of the month' }), { target: { value: '-1' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=MONTHLY;BYMONTHDAY=-1')
  })

  test('The second Tuesday gives BYDAY=2TU', () => {
    const onChange = vi.fn()
    render(<Host initial="monthly" onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: /The/ }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Which week of the month' }), { target: { value: '2' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Weekday' }), { target: { value: 'TU' } })
    expect(onChange).toHaveBeenLastCalledWith('FREQ=MONTHLY;BYDAY=2TU')
  })

  test('weekday buttons add days, and the last pressed one cannot be unpressed', () => {
    const onChange = vi.fn()
    render(<Host onChange={onChange} />)
    const wed = screen.getByRole('button', { name: 'Wednesday' })
    expect(wed.getAttribute('aria-pressed')).toBe('true')
    expect(wed.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Friday' }))
    expect(onChange).toHaveBeenLastCalledWith('FREQ=WEEKLY;BYDAY=WE,FR')
    expect(screen.getByRole('button', { name: 'Wednesday' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }))
    expect(onChange).toHaveBeenLastCalledWith('FREQ=WEEKLY;BYDAY=FR')
    expect(screen.getByRole('button', { name: 'Friday' }).disabled).toBe(true)
  })

  test('shows the next dates from the server', async () => {
    const api = { previewRecurrence: vi.fn().mockResolvedValue({ dates: ['2026-10-24', '2026-10-31'] }) }
    render(<Host api={api} />)
    expect(await screen.findByText('Next: Sat, Oct 24; Sat, Oct 31')).toBeTruthy()
    expect(api.previewRecurrence).toHaveBeenCalledWith('weekly', DUE, 3)
  })

  test('an empty list says it is the last one', async () => {
    const api = { previewRecurrence: vi.fn().mockResolvedValue({ dates: [] }) }
    render(<Host api={api} />)
    expect(await screen.findByText('No later dates: this is the last one.')).toBeTruthy()
  })

  test('shows nothing when the preview fails', async () => {
    const api = { previewRecurrence: vi.fn().mockRejectedValue(new Error('offline')) }
    render(<Host api={api} />)
    await waitFor(() => expect(api.previewRecurrence).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('previewText', () => {
  test('null, empty, and dates', () => {
    expect(previewText(null)).toBeNull()
    expect(previewText([])).toBe('No later dates: this is the last one.')
    expect(previewText(['2026-10-24'])).toBe('Next: Sat, Oct 24')
  })
})

describe('RepeatSelect', () => {
  test('Custom shows the builder and a preset hides it', () => {
    const onChange = vi.fn()
    render(<Host initial="" Component={RepeatSelect} onChange={onChange} />)
    expect(screen.queryByRole('group', { name: 'Every' })).toBeNull()
    const select = screen.getAllByRole('combobox')[0]
    fireEvent.change(select, { target: { value: 'custom' } })
    expect(screen.getByRole('group', { name: 'Every' })).toBeTruthy()
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'daily' } })
    expect(onChange).toHaveBeenLastCalledWith('daily')
    expect(screen.queryByRole('group', { name: 'Every' })).toBeNull()
  })

  test('a rule that is not a preset opens the builder', () => {
    render(<Host initial="every 3 days" Component={RepeatSelect} />)
    expect(screen.getByRole('group', { name: 'Every' })).toBeTruthy()
  })
})
