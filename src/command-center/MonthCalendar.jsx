import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { localIso } from './dueDates'

const WEEKDAY_HEADS = [
  ['Mon', 'Monday'], ['Tue', 'Tuesday'], ['Wed', 'Wednesday'], ['Thu', 'Thursday'],
  ['Fri', 'Friday'], ['Sat', 'Saturday'], ['Sun', 'Sunday'],
]

const parse = (iso) => new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
const shift = (iso, days) => { const d = parse(iso); return localIso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)) }
const shiftMonth = (iso, months) => {
  const d = parse(iso)
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1)
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  return localIso(new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last)))
}
const monthKey = (iso) => iso.slice(0, 7)

// A month of days to pick a due date from, Monday first. One tap on a day calls `onPick` with it as
// YYYY-MM-DD. The keyboard moves as a date grid does: the arrows by a day or a week, Page Up and
// Page Down by a month, Home and End to the ends of the week, and Enter or Space picks. Only the
// focused day is in the Tab order. `value` is the chosen date (shown pressed), `today` is marked as
// the current date, and the month shown starts at `value`, or `today` when there is none. `marks`
// are the next dates of the repeat being set (AddDuePanel.jsx), shown tinted and named as repeats.
// Days touch so seven fit at 320px with each still 44px; their focus rings are drawn inside.
export default function MonthCalendar({ value, today, onPick, label = 'Due date', marks = [] }) {
  const [focusIso, setFocusIso] = useState(value || today)
  const gridRef = useRef(null)
  const moveFocusRef = useRef(false)

  useEffect(() => { setFocusIso(value || today) }, [value, today])

  // After a key moves the focused day, focus the button now rendered for it.
  useEffect(() => {
    if (!moveFocusRef.current) return
    moveFocusRef.current = false
    gridRef.current?.querySelector(`[data-date="${focusIso}"]`)?.focus()
  }, [focusIso])

  const first = parse(`${monthKey(focusIso)}-01`)
  const lead = (first.getDay() + 6) % 7
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const cells = [...Array(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => localIso(new Date(first.getFullYear(), first.getMonth(), i + 1)))]
  while (cells.length % 7) cells.push(null)
  const weeks = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7))
  const monthTitle = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  function move(next) {
    moveFocusRef.current = true
    setFocusIso(next)
  }

  function onKeyDown(e) {
    const weekday = (parse(focusIso).getDay() + 6) % 7
    const moves = {
      ArrowLeft: () => shift(focusIso, -1),
      ArrowRight: () => shift(focusIso, 1),
      ArrowUp: () => shift(focusIso, -7),
      ArrowDown: () => shift(focusIso, 7),
      PageUp: () => shiftMonth(focusIso, -1),
      PageDown: () => shiftMonth(focusIso, 1),
      Home: () => shift(focusIso, -weekday),
      End: () => shift(focusIso, 6 - weekday),
    }
    if (!moves[e.key]) return
    e.preventDefault()
    // The dropdowns' own arrow-key handling (Menu.jsx) must not also act on these.
    e.stopPropagation()
    move(moves[e.key]())
  }

  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => setFocusIso(shiftMonth(focusIso, -1))}>
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <h3 className="cal-title" aria-live="polite">{monthTitle}</h3>
        <button type="button" className="icon-btn" aria-label="Next month" onClick={() => setFocusIso(shiftMonth(focusIso, 1))}>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </div>
      <table ref={gridRef} role="grid" aria-label={`${label}, ${monthTitle}`} className="cal-grid" onKeyDown={onKeyDown}>
        <thead>
          <tr>
            {WEEKDAY_HEADS.map(([short, full]) => (
              <th key={short} scope="col" abbr={full}>{short}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.find(Boolean)}>
              {week.map((iso, i) => (
                <td key={iso || `blank-${i}`}>
                  {iso && (
                    <button
                      type="button"
                      className="cal-day"
                      data-date={iso}
                      data-cal-focus={iso === focusIso ? '' : undefined}
                      tabIndex={iso === focusIso ? 0 : -1}
                      aria-pressed={iso === value}
                      aria-current={iso === today ? 'date' : undefined}
                      data-repeat={marks.includes(iso) ? '' : undefined}
                      aria-label={`${parse(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}${marks.includes(iso) ? ', repeats' : ''}`}
                      onClick={() => onPick(iso)}
                    >
                      {Number(iso.slice(8, 10))}
                    </button>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
