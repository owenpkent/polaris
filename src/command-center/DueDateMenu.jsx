import { useEffect, useRef, useState } from 'react'
import { Popover, useRovingFocus } from './Menu'
import { localIso, addDays } from './dueDates'

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
// Due date field (TaskDetailPanel.jsx): quick picks, a date box, and Clear. `value` is the
// task's dueAt (an ISO date or null); `onChange` gets the new plain date, or null for Clear.
export default function DueDateMenu({ anchorRef, open, onClose, value, dueBounds, onChange, label }) {
  const listRef = useRef(null)
  const onKeyDown = useRovingFocus(listRef)
  const dateOnly = value ? value.slice(0, 10) : ''

  // The date box edits a draft. Chromium fires a change event for every segment edit, so the
  // first digit of a new year would otherwise be saved as the year 0002 and close the menu
  // before the rest could be typed. Enter in the box or the Set date button saves the draft.
  const [draft, setDraft] = useState(dateOnly)
  useEffect(() => {
    if (open) setDraft(dateOnly)
  }, [open, dateOnly])

  const now = new Date()
  const nextMondayDays = ((1 - now.getDay() + 7) % 7) || 7

  function commit(next) {
    onClose()
    onChange(next)
  }

  function commitDraft() {
    if (!draft) return
    commit(draft)
  }

  // Up and Down step the focused segment of the date box, so they stay with it instead of
  // moving between menu items. Enter saves the draft.
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
          <button key={opt.key} type="button" role="menuitem" data-menu-item onClick={() => commit(opt.value)} style={menuItemStyle}>
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
        <button
          type="button"
          role="menuitem"
          data-menu-item
          disabled={!draft || draft === dateOnly}
          onClick={commitDraft}
          style={{
            ...menuItemStyle,
            color: !draft || draft === dateOnly ? 'var(--t3)' : 'var(--t1)',
            cursor: !draft || draft === dateOnly ? 'default' : 'pointer',
          }}
        >
          Set date
        </button>
        <div role="separator" style={{ height: 1, background: 'var(--bd)', margin: '6px 0' }} />
        <button type="button" role="menuitem" data-menu-item onClick={() => commit(null)} style={menuItemStyle}>
          Clear
        </button>
      </div>
    </Popover>
  )
}
