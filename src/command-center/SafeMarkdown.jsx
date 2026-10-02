// A tiny, safe markdown renderer for the digest. It never uses
// dangerouslySetInnerHTML: every piece of text below is inserted into React
// as a plain string, which React escapes automatically, so nothing from the
// server (including anything sourced from external, untrusted content) can
// inject HTML or scripts here. It supports just enough markdown for a daily
// digest: headings, lists, bold, inline code, links, and paragraphs.

const HEADING_STYLE = {
  1: { fontSize: '1.3rem', fontWeight: 700, margin: '1rem 0 0.6rem' },
  2: { fontSize: '1.1rem', fontWeight: 700, margin: '1rem 0 0.5rem' },
  3: { fontSize: '1rem', fontWeight: 600, margin: '0.85rem 0 0.4rem' },
  4: { fontSize: '0.9rem', fontWeight: 600, margin: '0.75rem 0 0.35rem' },
}

const PARA_STYLE = { fontSize: '0.9rem', lineHeight: 1.65, margin: '0 0 0.75rem', color: 'var(--t1)' }
const LIST_STYLE = { fontSize: '0.9rem', lineHeight: 1.65, margin: '0 0 0.75rem', paddingLeft: '1.4rem' }
const CODE_BLOCK_STYLE = {
  background: 'var(--bg2)',
  border: '1px solid var(--bd)',
  borderRadius: 8,
  padding: '0.75rem 1rem',
  fontSize: '0.82rem',
  overflowX: 'auto',
  margin: '0 0 0.75rem',
}
const INLINE_CODE_STYLE = { background: 'var(--bg2)', padding: '0.1rem 0.35rem', borderRadius: 4, fontSize: '0.85em' }

const INLINE_PATTERN = /(\*\*(.+?)\*\*)|(`([^`]+?)`)|(\[([^\]]+)\]\(([^)]+)\))/

export function isSafeHref(href) {
  return /^https?:\/\//i.test(href) || href.startsWith('mailto:')
}

function renderInline(text, keyPrefix) {
  const nodes = []
  let remaining = text
  let n = 0

  while (remaining.length > 0) {
    const match = INLINE_PATTERN.exec(remaining)
    if (!match) {
      nodes.push(remaining)
      break
    }
    const before = remaining.slice(0, match.index)
    if (before) nodes.push(before)

    if (match[1]) {
      nodes.push(<strong key={`${keyPrefix}-${n++}`}>{match[2]}</strong>)
    } else if (match[3]) {
      nodes.push(<code key={`${keyPrefix}-${n++}`} style={INLINE_CODE_STYLE}>{match[4]}</code>)
    } else if (match[5]) {
      const href = match[7]
      nodes.push(
        <a
          key={`${keyPrefix}-${n++}`}
          href={isSafeHref(href) ? href : undefined}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--blue)' }}
        >
          {match[6]}
        </a>
      )
    }
    remaining = remaining.slice(match.index + match[0].length)
  }

  return nodes
}

export default function SafeMarkdown({ text }) {
  if (!text) return null
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let i = 0
  let key = 0

  const isHeading = (l) => /^(#{1,4})\s+/.test(l)
  const isFence = (l) => /^```/.test(l)
  const isListItem = (l) => /^\s*([-*]|\d+\.)\s+/.test(l)

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { i++; continue }

    const headingMatch = /^(#{1,4})\s+(.*)$/.exec(line)
    if (headingMatch) {
      const level = headingMatch[1].length
      const Tag = `h${Math.min(level + 1, 6)}`
      blocks.push(
        <Tag key={key} style={HEADING_STYLE[level] || HEADING_STYLE[4]}>
          {renderInline(headingMatch[2], `h${key}`)}
        </Tag>
      )
      key++
      i++
      continue
    }

    if (isFence(line)) {
      const codeLines = []
      i++
      while (i < lines.length && !isFence(lines[i])) { codeLines.push(lines[i]); i++ }
      i++
      blocks.push(<pre key={key} style={CODE_BLOCK_STYLE}><code>{codeLines.join('\n')}</code></pre>)
      key++
      continue
    }

    if (isListItem(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items = []
      while (i < lines.length && isListItem(lines[i])) {
        const m = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(lines[i])
        items.push(m ? m[1] : lines[i])
        i++
      }
      const ListTag = ordered ? 'ol' : 'ul'
      blocks.push(
        <ListTag key={key} style={LIST_STYLE}>
          {items.map((item, idx) => <li key={idx}>{renderInline(item, `li${key}-${idx}`)}</li>)}
        </ListTag>
      )
      key++
      continue
    }

    const paraLines = []
    while (i < lines.length && lines[i].trim() !== '' && !isHeading(lines[i]) && !isFence(lines[i]) && !isListItem(lines[i])) {
      paraLines.push(lines[i])
      i++
    }
    blocks.push(<p key={key} style={PARA_STYLE}>{renderInline(paraLines.join(' '), `p${key}`)}</p>)
    key++
  }

  return <div>{blocks}</div>
}
