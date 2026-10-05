import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useConnection } from './ConnectionContext'
import { ErrorBanner, formatDate } from './shared'
import { useOffline } from './offlineStatus'

// A task's thread (docs/agent-threads-proposal.md): typed posts that the owner and the agents
// connected over MCP write about one hard problem. Polaris stores and shows them. The judgement
// is the owner's alone (stage 2): accepting or rejecting a claim, pinning a summary as the
// current state, closing, reopening, or forking the thread, hiding authors from the agents, and
// capping how much each agent may post in a day. Every one of those is a live click, never
// queued, and nothing here changes the task itself.
//
// Propose, do not act: an inbox task has no thread until the owner accepts it (the panel hides
// this section), and a task holding third-party text (untrustedText) is read-only here, so a
// one-click post never lands next to text nobody chose to trust.

export const POST_TYPES = [
  ['claim', 'Claim'],
  ['evidence', 'Evidence'],
  ['objection', 'Objection'],
  ['question', 'Question'],
  ['failed_attempt', 'Failed attempt'],
  ['summary', 'Summary'],
  ['result', 'Result'],
]

const TYPE_LABELS = Object.fromEntries(POST_TYPES)

// Chip colours per type, from the soft tints (CONTRIBUTING.md, Tints): the disagreements stand
// out in orange, the things an owner may accept in green, the rest stay quiet.
const TYPE_TINTS = {
  claim: ['var(--blue-soft)', 'var(--blue)'],
  evidence: ['var(--purple-soft)', 'var(--purple)'],
  objection: ['var(--orange-soft)', 'var(--orange)'],
  question: ['var(--neutral-soft)', 'var(--t2)'],
  failed_attempt: ['var(--red-soft)', 'var(--red)'],
  summary: ['var(--neutral-soft)', 'var(--t2)'],
  result: ['var(--green-soft)', 'var(--green)'],
}

// Status chips: accepted reads green, rejected red, the rest neutral.
const STATUS_LABELS = { open: 'Open', accepted: 'Accepted', rejected: 'Rejected', superseded: 'Superseded' }
const STATUS_TINTS = {
  open: ['var(--neutral-soft)', 'var(--t2)'],
  accepted: ['var(--green-soft)', 'var(--green)'],
  rejected: ['var(--red-soft)', 'var(--red)'],
  superseded: ['var(--neutral-soft)', 'var(--t2)'],
}
// The owner's verdicts on a claim or result, in the order the buttons appear.
const VERDICTS = [
  ['accepted', 'Accept'],
  ['rejected', 'Reject'],
  ['superseded', 'Supersede'],
]
const JUDGED_TYPES = new Set(['claim', 'result'])
const CONFIDENCE_LABELS = { low: 'Low confidence', medium: 'Medium confidence', high: 'High confidence' }

const OFFLINE_HINT = 'Offline. Posting needs the server.'
const UNTRUSTED_HINT = 'Posting is off here: this task holds text written by a third party.'

const heading = { fontSize: 14, fontWeight: 600, color: 'var(--t1)', margin: 0 }
const subheading = { fontSize: 13, fontWeight: 600, color: 'var(--t2)', margin: 0 }
const muted = { fontSize: 13, color: 'var(--t2)' }
const controlBorder = { border: '1px solid var(--bd-strong)', borderRadius: 8, background: 'var(--bg-inset)', color: 'var(--t1)', fontSize: 14 }
const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }

export function postTypeLabel(type) {
  return TYPE_LABELS[type] || type
}

export function postAuthor(post) {
  if (post.author === 'human') return 'You'
  return post.authorName || post.author || 'agent'
}

function TypeChip({ type }) {
  const [background, color] = TYPE_TINTS[type] || TYPE_TINTS.question
  return <span className="badge" style={{ background, color }}>{postTypeLabel(type)}</span>
}

function StatusChip({ status }) {
  const [background, color] = STATUS_TINTS[status] || STATUS_TINTS.open
  return <span className="badge" style={{ background, color }}>{STATUS_LABELS[status] || status}</span>
}

// One post. `controls` is null for a reader; otherwise the owner's buttons for this post: a pin
// (or unpin), and on a claim or result the verdicts it does not already carry.
function Post({ post, pinned, controls }) {
  const judged = JUDGED_TYPES.has(post.type) && post.status
  return (
    <li style={{ background: 'var(--bg-inset)', border: '1px solid var(--bd)', borderRadius: 8, padding: '10px 12px', listStyle: 'none' }}>
      <div style={{ ...row, marginBottom: 6 }}>
        <TypeChip type={post.type} />
        {judged && <StatusChip status={post.status} />}
        {pinned && <span className="badge" style={{ background: 'var(--blue-soft)', color: 'var(--blue)' }}>Pinned</span>}
        {post.untrustedText && (
          <span className="badge" style={{ background: 'var(--orange-soft)', color: 'var(--orange)' }}>Untrusted text</span>
        )}
        <span style={{ ...muted, fontSize: 12 }}>
          {postAuthor(post)} · {formatDate(post.createdAt)}
          {post.confidence ? ` · ${CONFIDENCE_LABELS[post.confidence] || post.confidence}` : ''}
        </span>
      </div>
      <div style={{ fontSize: 14, color: 'var(--t1)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{post.body}</div>
      {controls && (
        <div style={{ ...row, marginTop: 8 }}>
          {judged && VERDICTS.filter(([value]) => value !== post.status).map(([value, label]) => (
            <button key={value} type="button" className="btn btn-ghost" disabled={controls.disabled} onClick={() => controls.onStatus(post, value)}>
              {label}
            </button>
          ))}
          {judged && post.status !== 'open' && (
            <button type="button" className="btn btn-ghost" disabled={controls.disabled} onClick={() => controls.onStatus(post, 'open')}>
              Mark open
            </button>
          )}
          <button type="button" className="btn btn-ghost" disabled={controls.disabled} onClick={() => controls.onPin(pinned ? null : post)}>
            {pinned ? 'Unpin' : 'Pin'}
          </button>
        </div>
      )}
    </li>
  )
}

function Switch({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="btn btn-ghost"
      style={{ gap: 8 }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 34, height: 20, borderRadius: 10, position: 'relative', flex: 'none',
          background: checked ? 'var(--blue)' : 'var(--bd-strong)', transition: 'background 0.15s',
        }}
      >
        <span style={{
          position: 'absolute', top: 2, left: checked ? 16 : 2, width: 16, height: 16, borderRadius: 8,
          background: 'var(--on-accent)', transition: 'left 0.15s',
        }} />
      </span>
      {label}
    </button>
  )
}

// `refreshKey` changes whenever the panel reloads its task (its own writes and the events poll),
// so the thread follows the same refresh and never runs a poller of its own.
export default function ThreadSection({ task, refreshKey = 0, onOpenTask }) {
  const { api } = useConnection()
  const offline = useOffline()
  const [thread, setThread] = useState(null)
  const [posts, setPosts] = useState([])
  const [total, setTotal] = useState(0)
  const [pinnedFromServer, setPinnedFromServer] = useState(null)
  const [loaded, setLoaded] = useState(false)
  // True when the server could not be reached and no thread was loaded before: a 404 never lands
  // in the offline copy, so with the server away a task with no thread looks like a network error.
  // That is "unknown", not a fault to raise an alert for.
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [objectionsOnly, setObjectionsOnly] = useState(false)
  const [type, setType] = useState('claim')
  const [draft, setDraft] = useState('')
  const [forkOpen, setForkOpen] = useState(false)
  const [forkTitle, setForkTitle] = useState('')
  // The cap field as typed; the thread's value lands here on every load.
  const [cap, setCap] = useState('')
  // The task the successor thread lives on, looked up once per successor id.
  const [successorTaskId, setSuccessorTaskId] = useState(null)
  const forkButtonRef = useRef(null)
  const headingId = useId()
  const typeId = useId()
  const bodyId = useId()
  const forkId = useId()
  const capId = useId()
  const taskId = task?.id
  const readOnly = Boolean(task?.untrustedText)

  const load = useCallback(async () => {
    if (!taskId) return
    try {
      const res = await api.getThread(taskId)
      setThread(res?.thread || null)
      setPosts(res?.posts || [])
      setTotal(typeof res?.total === 'number' ? res.total : (res?.posts || []).length)
      setPinnedFromServer(res?.pinned || null)
      setCap(res?.thread?.dailyCap == null ? '' : String(res.thread.dailyCap))
      setUnavailable(false)
      setError(null)
    } catch (err) {
      if (err?.status === 0 || err?.code === 'network_error') {
        // Keep whatever was loaded last; say nothing alarming when there is nothing to show.
        setUnavailable(true)
        setError(null)
      } else {
        setError(err.message || 'Could not load the thread.')
      }
    } finally {
      setLoaded(true)
    }
  }, [api, taskId])

  useEffect(() => { load() }, [load, refreshKey])

  const successorId = thread?.successorThreadId || null
  useEffect(() => {
    let cancelled = false
    setSuccessorTaskId(null)
    if (!successorId) return undefined
    api.getThreadPosts(successorId)
      .then((res) => { if (!cancelled) setSuccessorTaskId(res?.thread?.taskId || null) })
      .catch(() => { /* the button simply stays away */ })
    return () => { cancelled = true }
  }, [api, successorId])

  // Runs one owner action against the server, then reloads. The error banner reports a failure
  // and the thread on screen stays as it was.
  async function run(action, failure) {
    if (busy) return false
    setBusy(true)
    try {
      await action()
      await load()
      return true
    } catch (err) {
      setError(err.message || failure)
      return false
    } finally {
      setBusy(false)
    }
  }

  const handleStart = () => run(() => api.createThread(taskId), 'Could not start a thread.')

  async function handlePost() {
    const body = draft.trim()
    if (!body || !thread) return
    const ok = await run(() => api.addPost(thread.id, { type, body }), 'Could not post.')
    if (ok) setDraft('')
  }

  const handleStatus = (post, status) => run(() => api.setPostStatus(post.id, status), 'Could not change that post.')
  const handlePin = (post) => run(() => api.patchThread(thread.id, { pinnedPostId: post ? post.id : null }), 'Could not pin that post.')
  const handleClose = () => run(() => api.closeThread(thread.id), 'Could not close the thread.')
  const handleReopen = () => run(() => api.reopenThread(thread.id), 'Could not reopen the thread.')
  const handleHideAuthors = (authorHidden) => run(() => api.patchThread(thread.id, { authorHidden }), 'Could not change that setting.')

  async function handleFork() {
    const title = forkTitle.trim()
    if (!title) return
    const ok = await run(() => api.forkThread(thread.id, title), 'Could not fork the thread.')
    if (ok) {
      setForkOpen(false)
      setForkTitle('')
    }
  }

  function cancelFork() {
    setForkOpen(false)
    setForkTitle('')
    forkButtonRef.current?.focus()
  }

  function saveCap() {
    const trimmed = cap.trim()
    const next = trimmed === '' ? null : Number(trimmed)
    if (next !== null && (!Number.isInteger(next) || next < 1)) {
      setError('The daily cap is a whole number of posts, or empty for none.')
      return
    }
    if (next === (thread.dailyCap ?? null)) return
    run(() => api.patchThread(thread.id, { dailyCap: next }), 'Could not change the cap.')
  }

  if (task?.status === 'inbox') return null

  const open = thread?.status === 'open'
  // The owner acts on an open thread; a closed one is read until it is reopened.
  const canAct = Boolean(thread) && !readOnly && open
  const disabled = offline || busy
  const controls = canAct ? { disabled, onStatus: handleStatus, onPin: handlePin } : null
  // The server sends the pinned post by id, since it may be older than the window of posts loaded.
  const pinnedPost = thread?.pinnedPostId ? pinnedFromServer || posts.find((p) => p.id === thread.pinnedPostId) || null : null
  const shown = objectionsOnly ? posts.filter((p) => p.type === 'objection') : posts
  const objections = posts.filter((p) => p.type === 'objection').length

  return (
    <section aria-labelledby={headingId} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <h3 id={headingId} style={heading}>Thread</h3>
        {thread && posts.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost"
            aria-pressed={objectionsOnly}
            onClick={() => setObjectionsOnly((v) => !v)}
          >
            Objections only{objections > 0 ? ` (${objections})` : ''}
          </button>
        )}
      </div>

      <ErrorBanner message={error} onRetry={load} />

      {loaded && !thread && unavailable && <div style={muted}>Thread unavailable offline.</div>}

      {loaded && !thread && !unavailable && (
        <>
          <div style={muted}>
            No thread yet. A thread is where you and your agents argue one problem out in typed posts: claims, evidence, objections, and results.
          </div>
          {readOnly ? (
            <div style={muted}>{UNTRUSTED_HINT}</div>
          ) : (
            <div style={{ ...row, gap: 12 }}>
              <button type="button" className="btn" onClick={handleStart} disabled={disabled}>
                {busy ? 'Starting…' : 'Start a thread'}
              </button>
              {offline && <span style={muted}>{OFFLINE_HINT}</span>}
            </div>
          )}
        </>
      )}

      {thread && (
        <>
          {!open && (
            <div style={{ ...row, gap: 12 }}>
              <span style={muted}>Closed{thread.closedAt ? ` ${formatDate(thread.closedAt)}` : ''}.</span>
              {successorTaskId && onOpenTask && (
                <button type="button" className="btn btn-ghost" onClick={() => onOpenTask(successorTaskId)}>
                  Open the successor thread
                </button>
              )}
              {!readOnly && (
                <button type="button" className="btn btn-ghost" onClick={handleReopen} disabled={disabled}>
                  Reopen thread
                </button>
              )}
            </div>
          )}

          {canAct && (
            <div role="group" aria-label="Thread settings" style={{ ...row, gap: 6 }}>
              <button type="button" className="btn btn-ghost" onClick={handleClose} disabled={disabled}>Close thread</button>
              <button
                ref={forkButtonRef}
                type="button"
                className="btn btn-ghost"
                aria-expanded={forkOpen}
                onClick={() => setForkOpen((v) => !v)}
                disabled={disabled}
              >
                Fork
              </button>
              <Switch checked={Boolean(thread.authorHidden)} onChange={handleHideAuthors} label="Hide authors from agents" disabled={disabled} />
              <label htmlFor={capId} style={muted}>Daily cap per agent</label>
              <input
                id={capId}
                type="number"
                inputMode="numeric"
                min={1}
                value={cap}
                placeholder="None"
                disabled={disabled}
                onChange={(e) => setCap(e.target.value)}
                onBlur={saveCap}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveCap() } }}
                style={{ ...controlBorder, height: 44, width: 88, padding: '0 10px' }}
              />
            </div>
          )}

          {forkOpen && canAct && (
            <form
              onSubmit={(e) => { e.preventDefault(); handleFork() }}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelFork() } }}
              style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid var(--bd)', borderRadius: 8 }}
            >
              <div style={muted}>Fork closes this thread and continues it on a new subtask of this task.</div>
              <label htmlFor={forkId} style={muted}>Title of the new thread</label>
              <input
                id={forkId}
                autoFocus
                value={forkTitle}
                onChange={(e) => setForkTitle(e.target.value)}
                disabled={disabled}
                style={{ ...controlBorder, height: 44, padding: '0 10px' }}
              />
              <div style={row}>
                <button type="submit" className="btn" disabled={disabled || !forkTitle.trim()}>{busy ? 'Forking…' : 'Fork thread'}</button>
                <button type="button" className="btn btn-ghost" onClick={cancelFork}>Cancel</button>
              </div>
            </form>
          )}

          {total > posts.length && <div style={muted}>{total - posts.length} earlier posts are not shown.</div>}

          {pinnedPost && (
            <section aria-label="Pinned state" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h4 style={subheading}>Pinned state</h4>
              <ul style={{ margin: 0, padding: 0 }}>
                <Post post={pinnedPost} pinned controls={canAct ? { disabled, onStatus: handleStatus, onPin: handlePin } : null} />
              </ul>
            </section>
          )}

          {posts.length === 0 && <div style={muted}>No posts yet.</div>}
          {posts.length > 0 && shown.length === 0 && <div style={muted}>No objections yet.</div>}
          {shown.length > 0 && (
            <ul aria-label="Posts" style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0 }}>
              {shown.map((p) => <Post key={p.id} post={p} pinned={p.id === thread.pinnedPostId} controls={controls} />)}
            </ul>
          )}

          {readOnly ? (
            <div style={muted}>{UNTRUSTED_HINT}</div>
          ) : open && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={row}>
                <label htmlFor={typeId} style={muted}>Post type</label>
                <select
                  id={typeId}
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  disabled={busy}
                  style={{ ...controlBorder, height: 44, padding: '0 10px', minWidth: 160 }}
                >
                  {POST_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
              <label htmlFor={bodyId} className="sr-only">New post</label>
              <textarea
                id={bodyId}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Write a post"
                rows={3}
                disabled={busy}
                style={{ ...controlBorder, padding: '10px 14px', resize: 'vertical', fontFamily: 'inherit' }}
              />
              <div style={{ ...row, gap: 12 }}>
                <button type="button" className="btn" onClick={handlePost} disabled={disabled || !draft.trim()}>
                  {busy ? 'Posting…' : 'Post'}
                </button>
                {offline && <span style={muted}>{OFFLINE_HINT}</span>}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
