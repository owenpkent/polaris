import { useEffect, useRef, useState } from 'react'
import { Popover, useRovingFocus } from './Menu'
import { localIso, addDays, dueDateOnly, dueTimeOnly, joinDue, withDueDate } from './dueDates'

const menuItemStyle = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  minHeight: 44,
  padding: '0 14px',
  background: 'transparent',
  border: 'none',
  textAlign: 'left',
  font: 'inherit',
  fontSize: 14,
  color: 'var(--t1)',
  cursor: 'pointer',
}

// The due-date picker shared by a list row's Due date cell (TaskRow.jsx) and the task panel's
// Due date field (TaskDetailPanel.jsx): quick picks, a date box and an optional time box, and
// Clear. `value` is the task's dueAt (a day, or a day and a time, or null); `onChange` gets the new
// dueAt ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM', floating local time), or null for Clear. A quick pick
// changes the day and keeps the time already set, as the date box does; Remove time keeps the day.
export default function DueDateMenu({ anchorRef, open, onClose, value, dueBounds, onChange, label }) {
  const listRef = useRef(null)
  const onKeyDown = useRovingFocus(listRef)
  const dateOnly = dueDateOnly(value) || ''
  const timeOnly = dueTimeOnly(value) || ''

  // The date and time boxes edit a draft. Chromium fires a change event for every segment edit, so
  // the first digit of a new year would otherwise be saved as the year 0002 and close the menu
  // before the rest could be typed. Enter in a box or the Set date button saves the draft.
  const [draft, setDraft] = useState(dateOnly)
  const [draftTime, setDraftTime] = useState(timeOnly)
  useEffect(() => {
    if (open) {
      setDraft(dateOnly)
      setDraftTime(timeOnly)
    }
  }, [open, dateOnly, timeOnly])
  const unchanged = draft === dateOnly && draftTime === timeOnly

  const now = new Date()
  const nextMondayDays = ((1 - now.getDay() + 7) % 7) || 7

  function commit(next) {
    onClose()
    onChange(next)
  }

  function commitDraft() {
    if (!draft || unchanged) return
    commit(joinDue(draft, draftTime))
  }

  // A time with no day yet goes on today, so typing a time alone is enough.
  function changeTime(next) {
    setDraftTime(next)
    if (next && !draft) setDraft(dueBounds.today)
  }

  // Up and Down step the focused segment of the date or time box, so they stay with it instead
  // of moving between menu items. Enter saves the draft.
  function onDateKeyDown(e) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.stopPropagation()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commitDraft()
    }
  }

  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} minWidth={200}>
      <div ref={listRef} role="menu" aria-label={label} onKeyDown={onKeyDown} style={{ padding: '6px 0' }}>
        {[
          { key: 'today', label: 'Today', value: dueBounds.today },
          { key: 'tomorrow', label: 'Tomorrow', value: dueBounds.tomorrow },
          { key: 'monday', label: 'Next Monday', value: localIso(addDays(now, nextMondayDays)) },
          { key: 'week', label: 'In one week', value: localIso(addDays(now, 7)) },
        ].map((opt) => (
          <button key={opt.key} type="button" role="menuitem" data-menu-item onClick={() => commit(withDueDate(value, opt.value))} style={menuItemStyle}>
            {opt.label}
          </button>
        ))}
        <div role="separator" style={{ height: 1, background: 'var(--bd)', margin: '6px 0' }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, padding: '0 14px', fontSize: 14, color: 'var(--t1)' }}>
          <span style={{ flexShrink: 0, color: 'var(--t2)' }}>Date</span>
          <input
            type="date"
            data-menu-item
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDateKeyDown}
            style={{ flexGrow: 1, minWidth: 0, height: 32, padding: '0 8px', fontSize: 13 }}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, padding: '0 14px', fontSize: 14, color: 'var(--t1)' }}>
          <span style={{ flexShrink: 0, color: 'var(--t2)' }}>Time</span>
          <input
            type="time"
            data-menu-item
            value={draftTime}
            onChange={(e) => changeTime(e.target.value)}
            onKeyDown={onDateKeyDown}
            style={{ flexGrow: 1, minWidth: 0, height: 32, padding: '0 8px', fontSize: 13 }}
          />
        </label>
        <button
          type="button"
          role="menuitem"
          data-menu-item
          disabled={!draft || unchanged}
          onClick={commitDraft}
          style={{
            ...menuItemStyle,
            color: !draft || unchanged ? 'var(--t3)' : 'var(--t1)',
            cursor: !draft || unchanged ? 'default' : 'pointer',
          }}
        >
          {draftTime ? 'Set date and time' : 'Set date'}
        </button>
        {timeOnly && (
          <button type="button" role="menuitem" data-menu-item onClick={() => commit(dateOnly)} style={menuItemStyle}>
            Remove time
          </button>
        )}
        <div role="separator" style={{ height: 1, background: 'var(--bd)', margin: '6px 0' }} />
        <button type="button" role="menuitem" data-menu-item onClick={() => commit(null)} style={menuItemStyle}>
          Clear
        </button>
      </div>
    </Popover>
  )
}
