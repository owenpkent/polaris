import { useCallback, useEffect, useId, useState } from 'react'
import { useConnection } from './ConnectionContext'
import { ErrorBanner, formatDate } from './shared'
import { useOffline } from './offlineStatus'

// A task's thread (docs/agent-threads-proposal.md, stage 1): typed posts that the owner and the
// agents connected over MCP write about one hard problem. Polaris stores and shows them; it never
// judges them. Every post carries its type so an objection can be told from a claim at a glance,
// and the owner is the only reader who can post from here. Nothing here changes the task itself.
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

const STATUS_LABELS = { accepted: 'Accepted', rejected: 'Rejected', superseded: 'Superseded' }
const CONFIDENCE_LABELS = { low: 'Low confidence', medium: 'Medium confidence', high: 'High confidence' }

const OFFLINE_HINT = 'Offline. Posting needs the server.'
const UNTRUSTED_HINT = 'Posting is off here: this task holds text written by a third party.'

const heading = { fontSize: 14, fontWeight: 600, color: 'var(--t1)', margin: 0 }
const muted = { fontSize: 13, color: 'var(--t2)' }
const controlBorder = { border: '1px solid var(--bd-strong)', borderRadius: 8, background: 'var(--bg-inset)', color: 'var(--t1)', fontSize: 14 }

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

function Post({ post }) {
  const status = post.status && post.status !== 'open' ? STATUS_LABELS[post.status] || post.status : null
  return (
    <li style={{ background: 'var(--bg-inset)', border: '1px solid var(--bd)', borderRadius: 8, padding: '10px 12px', listStyle: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <TypeChip type={post.type} />
        {status && <span className="badge" style={{ background: 'var(--neutral-soft)', color: 'var(--t2)' }}>{status}</span>}
        {post.untrustedText && (
          <span className="badge" style={{ background: 'var(--orange-soft)', color: 'var(--orange)' }}>Untrusted text</span>
        )}
        <span style={{ ...muted, fontSize: 12 }}>
          {postAuthor(post)} · {formatDate(post.createdAt)}
          {post.confidence ? ` · ${CONFIDENCE_LABELS[post.confidence] || post.confidence}` : ''}
        </span>
      </div>
      <div style={{ fontSize: 14, color: 'var(--t1)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{post.body}</div>
    </li>
  )
}

// `refreshKey` changes whenever the panel reloads its task (its own writes and the events poll),
// so the thread follows the same refresh and never runs a poller of its own.
export default function ThreadSection({ task, refreshKey = 0 }) {
  const { api } = useConnection()
  const offline = useOffline()
  const [thread, setThread] = useState(null)
  const [posts, setPosts] = useState([])
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
  const headingId = useId()
  const typeId = useId()
  const bodyId = useId()
  const taskId = task?.id
  const readOnly = Boolean(task?.untrustedText)

  const load = useCallback(async () => {
    if (!taskId) return
    try {
      const res = await api.getThread(taskId)
      setThread(res?.thread || null)
      setPosts(res?.posts || [])
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

  async function handleStart() {
    if (busy) return
    setBusy(true)
    try {
      await api.createThread(taskId)
      await load()
    } catch (err) {
      setError(err.message || 'Could not start a thread.')
    } finally {
      setBusy(false)
    }
  }

  async function handlePost() {
    const body = draft.trim()
    if (!body || busy || !thread) return
    setBusy(true)
    try {
      await api.addPost(thread.id, { type, body })
      setDraft('')
      await load()
    } catch (err) {
      setError(err.message || 'Could not post.')
    } finally {
      setBusy(false)
    }
  }

  if (task?.status === 'inbox') return null

  const shown = objectionsOnly ? posts.filter((p) => p.type === 'objection') : posts
  const objections = posts.filter((p) => p.type === 'objection').length

  return (
    <section aria-labelledby={headingId} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button type="button" className="btn" onClick={handleStart} disabled={offline || busy}>
                {busy ? 'Starting…' : 'Start a thread'}
              </button>
              {offline && <span style={muted}>{OFFLINE_HINT}</span>}
            </div>
          )}
        </>
      )}

      {thread && (
        <>
          {thread.status === 'closed' && <div style={muted}>This thread is closed.</div>}
          {posts.length === 0 && <div style={muted}>No posts yet.</div>}
          {posts.length > 0 && shown.length === 0 && <div style={muted}>No objections yet.</div>}
          {shown.length > 0 && (
            <ul aria-label="Posts" style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0 }}>
              {shown.map((p) => <Post key={p.id} post={p} />)}
            </ul>
          )}

          {readOnly ? (
            <div style={muted}>{UNTRUSTED_HINT}</div>
          ) : thread.status !== 'closed' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <button type="button" className="btn" onClick={handlePost} disabled={offline || busy || !draft.trim()}>
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
