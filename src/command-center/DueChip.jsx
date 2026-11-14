import { Repeat } from 'lucide-react'

// The soft background behind a due chip, matching the text colour formatDueCell chose.
const CHIP_BACKGROUNDS = { 'var(--green)': 'var(--green-soft)', 'var(--red)': 'var(--red-soft)' }

// A due date as a chip (.due-chip in index.css): one size wherever it repeats down a list (a phone
// row, a Board card, a search result), its words centred, so the dates line up as a column. `due`
// is what formatDueCell returned. With a time the day and the time each stay whole, the time on
// a line of its own under the day. A repeating task's glyph is inside the chip, after the day, so
// a chip is as wide whether or not its task repeats.
export default function DueChip({ due, repeat = false }) {
  if (!due.text) return null
  const glyph = repeat ? <Repeat size={12} aria-hidden="true" className="repeat-glyph" /> : null
  return (
    <span
      className={due.time ? 'due-chip has-time' : 'due-chip'}
      style={{ background: CHIP_BACKGROUNDS[due.color] || 'var(--neutral-soft)', color: due.color || 'var(--t1)' }}
    >
      {due.time ? (
        <>
          <span>{due.date}{glyph}</span> <span>{due.time}</span>
        </>
      ) : (
        <>
          {due.text}{glyph}
        </>
      )}
    </span>
  )
}
