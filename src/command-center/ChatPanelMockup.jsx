import { useEffect, useRef, useState } from 'react'
import { Mic, Send, X } from 'lucide-react'

// Phase 3 mockup (initiatives/command-center-everywhere.md). Everything here is canned: no
// request leaves the browser, no model is called, and Apply writes nothing. It exists so the
// layout and the propose-then-apply flow can be approved before the real panel is built.
// Shown only when the URL carries ?chat=mockup (see App.jsx).

const SUGGESTIONS = [
  { id: 'overdue', label: 'What is overdue for the studio?' },
  { id: 'move', label: 'Move everything from the client email to Friday' },
  { id: 'week', label: 'What is due this week?' },
]

const CANNED = {
  overdue: {
    kind: 'answer',
    summary: '3 overdue tasks in studio projects',
    tasks: [
      { id: 'm1', title: 'Send SXSW application follow-up', project: 'Studio-Bios', due: 'Sep 12', overdue: true },
      { id: 'm2', title: 'Finish the explainer script draft', project: 'Sample-Videos', due: 'Sep 15', overdue: true },
      { id: 'm3', title: 'Update the conference schedule', project: 'Studio-Bios', due: 'Sep 16', overdue: true },
    ],
  },
  week: {
    kind: 'answer',
    summary: '2 tasks due this week',
    tasks: [
      { id: 'm4', title: 'Review the lecture slides', project: 'Sample-Videos', due: 'Sep 19' },
      { id: 'm5', title: 'Order muslin for the fit test', project: 'Adaptive Clothing', due: 'Sep 20' },
    ],
  },
  move: {
    kind: 'proposal',
    summary: 'Set the due date to Fri, Sep 25 on 3 tasks from the client email',
    // Tasks that came from Gmail carry third-party text, so the planner sees and shows
    // structured fields only. The title is withheld until the owner opens the task themselves.
    tasks: [
      { id: 'm6', title: 'Task from Gmail (open to read)', project: 'Studio-Marketing', due: 'Sep 21', nextDue: 'Sep 25', untrusted: true },
      { id: 'm7', title: 'Task from Gmail (open to read)', project: 'Studio-Marketing', due: 'Sep 22', nextDue: 'Sep 25', untrusted: true },
      { id: 'm8', title: 'Task from Gmail (open to read)', project: 'Studio-Marketing', due: 'No date', nextDue: 'Sep 25', untrusted: true },
    ],
  },
  fallback: {
    kind: 'note',
    summary: 'This is a mockup, so only the three suggested questions have an answer.',
    tasks: [],
  },
}

function matchCanned(text) {
  const t = text.toLowerCase()
  if (t.includes('overdue')) return 'overdue'
  if (t.includes('move') || t.includes('friday')) return 'move'
  if (t.includes('week')) return 'week'
  return 'fallback'
}

function ResultRow({ task }) {
  return (
    <button type="button" className="chat-row hover-surface" aria-label={`Open ${task.title}`}>
      <span className="chat-row-title">{task.title}</span>
      <span className="chat-row-meta">
        <span className="badge badge-planning">{task.project}</span>
        {task.untrusted && <span className="badge chat-badge-source">Gmail</span>}
        <span className={task.overdue ? 'chat-due chat-due-overdue' : 'chat-due'}>
          {task.nextDue ? `${task.due} to ${task.nextDue}` : task.due}
        </span>
      </span>
    </button>
  )
}

function Reply({ reply, onResolve }) {
  const data = CANNED[reply.cannedId]
  return (
    <div className="chat-reply">
      <div className="chat-reply-summary">{data.summary}</div>
      {data.tasks.length > 0 && (
        <div className="surface flush-last chat-rows">
          {data.tasks.map((task) => <ResultRow key={task.id} task={task} />)}
        </div>
      )}
      {data.kind === 'proposal' && reply.state === 'open' && (
        <div className="chat-proposal-actions">
          <button type="button" className="btn btn-primary" onClick={() => onResolve(reply.id, 'applied')}>
            Apply to 3 tasks
          </button>
          <button type="button" className="btn" onClick={() => onResolve(reply.id, 'discarded')}>
            Discard
          </button>
        </div>
      )}
      {data.kind === 'proposal' && reply.state === 'applied' && (
        <div className="chat-proposal-result">Applied (mockup: nothing was written).</div>
      )}
      {data.kind === 'proposal' && reply.state === 'discarded' && (
        <div className="chat-proposal-result">Discarded. Nothing was changed.</div>
      )}
    </div>
  )
}

export default function ChatPanelMockup({ open, onClose, openButtonRef }) {
  const containerRef = useRef(null)
  const scrollRef = useRef(null)
  const prevOpenRef = useRef(open)
  const nextIdRef = useRef(0)
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')

  // Esc-to-close and the same Tab/Shift+Tab focus trap as NavDrawer.
  useEffect(() => {
    if (!open) return undefined
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !containerRef.current) return
      const focusables = Array.from(
        containerRef.current.querySelectorAll('button:not(:disabled), textarea')
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === first || !containerRef.current.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !containerRef.current.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (open) containerRef.current?.querySelector('button')?.focus()
  }, [open])

  useEffect(() => {
    if (prevOpenRef.current && !open) openButtonRef?.current?.focus()
    prevOpenRef.current = open
  }, [open, openButtonRef])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  if (!open) return null

  const ask = (text, cannedId) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const stamp = nextIdRef.current++
    setMessages((prev) => [
      ...prev,
      { id: `q${stamp}`, role: 'user', text: trimmed },
      { id: `a${stamp}`, role: 'reply', cannedId: cannedId || matchCanned(trimmed), state: 'open' },
    ])
    setDraft('')
  }

  const resolve = (id, state) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, state } : m)))
  }

  return (
    <aside ref={containerRef} role="dialog" aria-label="Ask Polaris" className="chat-panel">
      <div className="chat-panel-header">
        <span className="chat-panel-title">
          Ask
          <span className="badge badge-planning">Mockup</span>
        </span>
        <button type="button" aria-label="Close chat" onClick={onClose} className="icon-btn">
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      <div ref={scrollRef} className="chat-panel-body">
        {messages.length === 0 && (
          <p className="chat-empty">
            Pick a question below, or type one. Changes come back as a proposal and nothing is
            written until you click Apply.
          </p>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="chat-question">{m.text}</div>
          ) : (
            <Reply key={m.id} reply={m} onResolve={resolve} />
          )
        )}
      </div>

      <div className="chat-panel-footer">
        <div className="chat-suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s.id} type="button" className="btn chat-suggestion" onClick={() => ask(s.label, s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <form
          className="chat-input-row"
          onSubmit={(e) => {
            e.preventDefault()
            ask(draft)
          }}
        >
          <textarea
            className="chat-input"
            rows={2}
            value={draft}
            placeholder="Ask about your tasks"
            aria-label="Question"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                ask(draft)
              }
            }}
          />
          <button type="button" className="icon-btn" aria-label="Dictate (not built in the mockup)" disabled>
            <Mic size={20} aria-hidden="true" />
          </button>
          <button type="submit" className="icon-btn chat-send" aria-label="Send" disabled={!draft.trim()}>
            <Send size={20} aria-hidden="true" />
          </button>
        </form>
      </div>
    </aside>
  )
}
