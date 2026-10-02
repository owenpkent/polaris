import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Lock, LockOpen, Play, ShieldCheck } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useOffline } from './offlineStatus'
import { ConfirmButton, ErrorBanner } from './shared'

// 18 random bytes are 144 bits. Made here, in the browser, which has to show it to the owner anyway:
// the server then never has a reason to send a passphrase to anyone.
export function makePassphrase(random = (bytes) => crypto.getRandomValues(bytes)) {
  const bytes = random(new Uint8Array(18))
  const text = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_')
  return text.match(/.{4}/g).join('-')
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem 0.75rem', fontSize: '0.85rem', padding: '0.3rem 0' }}>
      <span style={{ color: 'var(--t2)', flex: '0 0 7.5rem' }}>{label}</span>
      <span style={{ flex: '1 1 12rem', minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
    </div>
  )
}

function Notice({ tone, children }) {
  return (
    <div
      role="status"
      style={{
        padding: '0.6rem 0.85rem',
        borderRadius: 8,
        fontSize: '0.85rem',
        margin: '0.75rem 0',
        background: `var(--${tone}-soft)`,
        color: 'var(--t1)',
        borderLeft: `3px solid var(--${tone})`,
      }}
    >
      {children}
    </div>
  )
}

const checkboxLabelStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  minHeight: 44,
  fontSize: '0.85rem',
  cursor: 'pointer',
}

// The form that sets a passphrase, for turning encryption on and for changing it. Esc closes it.
// `disabled` is the card's write guard (offline, or another action busy). It can turn on while the
// form is open, and then nothing in it may be sent.
function PassphraseForm({ replacing, minLength, busy, disabled = false, onSubmit, onCancel }) {
  const [mode, setMode] = useState('made')
  const [made, setMade] = useState(() => makePassphrase())
  const [typed, setTyped] = useState('')
  const [again, setAgain] = useState('')
  const [show, setShow] = useState(false)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const firstField = useRef(null)

  useEffect(() => { firstField.current?.focus() }, [])

  const passphrase = mode === 'made' ? made : typed
  // Spaces at the ends are part of the passphrase but do not count towards its length: the same
  // rule the server applies.
  const typedLength = typed.trim().length
  let problem = null
  if (mode === 'typed') {
    if (typed.length > 0 && typedLength < minLength) problem = `Use ${minLength} or more characters, not counting spaces at the ends. That is ${typedLength}.`
    else if (again.length > 0 && again !== typed) problem = 'The two do not match.'
  }
  const ready = saved && !busy && !disabled && (mode === 'made' || (typedLength >= minLength && typed === again))

  async function copy() {
    try {
      await navigator.clipboard.writeText(made)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <form
      aria-label={replacing ? 'Change the backup passphrase' : 'Turn on backup encryption'}
      onSubmit={(e) => { e.preventDefault(); if (ready && !disabled) onSubmit(passphrase) }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}
      style={{ marginTop: '0.75rem', padding: '1rem', background: 'var(--bg2)', borderRadius: 10 }}
    >
      <fieldset style={{ border: 0, padding: 0, margin: '0 0 0.5rem' }}>
        <legend style={{ fontSize: '0.85rem', color: 'var(--t2)', fontWeight: 500, marginBottom: '0.25rem' }}>Passphrase</legend>
        <label style={checkboxLabelStyle}>
          <input ref={firstField} type="radio" name="cc-passphrase-mode" checked={mode === 'made'} onChange={() => { setMode('made'); setSaved(false) }} style={{ width: 18, height: 18 }} />
          Make a strong one for me
        </label>
        <label style={checkboxLabelStyle}>
          <input type="radio" name="cc-passphrase-mode" checked={mode === 'typed'} onChange={() => { setMode('typed'); setSaved(false) }} style={{ width: 18, height: 18 }} />
          I will type my own
        </label>
      </fieldset>

      {mode === 'made' ? (
        <div className="field">
          <label htmlFor="cc-made-passphrase">Your passphrase</label>
          <input id="cc-made-passphrase" type="text" readOnly value={made} onFocus={(e) => e.target.select()} style={{ fontFamily: 'ui-monospace, monospace' }} />
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={copy}><Copy size={14} aria-hidden="true" /> {copied ? 'Copied' : 'Copy'}</button>
            <button type="button" className="btn" onClick={() => { setMade(makePassphrase()); setCopied(false); setSaved(false) }}>Make another</button>
          </div>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="cc-typed-passphrase">Passphrase ({minLength} or more characters)</label>
            <input id="cc-typed-passphrase" type={show ? 'text' : 'password'} value={typed} onChange={(e) => { setTyped(e.target.value); setSaved(false) }} autoComplete="new-password" />
          </div>
          <div className="field">
            <label htmlFor="cc-typed-passphrase-again">The same passphrase again</label>
            <input id="cc-typed-passphrase-again" type={show ? 'text' : 'password'} value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          </div>
          <label style={checkboxLabelStyle}>
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} style={{ width: 18, height: 18 }} />
            Show what I type
          </label>
          {problem && <p role="alert" style={{ fontSize: '0.85rem', color: 'var(--red)', margin: '0.25rem 0' }}>{problem}</p>}
        </>
      )}

      <Notice tone="yellow">
        Without this passphrase no encrypted backup can ever be read, on this machine or any other. It cannot be
        recovered and it is not shown again.
        {replacing ? ' Backups made so far will still need the old passphrase, so keep both until the old ones have aged out.' : ''}
      </Notice>

      <label style={checkboxLabelStyle}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} style={{ width: 18, height: 18 }} />
        I have saved this passphrase in my password manager
      </label>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
        <button type="submit" className="btn btn-primary" disabled={!ready}>
          {busy ? 'Saving…' : (replacing ? 'Change passphrase' : 'Turn on encryption')}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        {disabled && !busy && <span role="status" style={{ fontSize: '0.8rem', color: 'var(--t2)', alignSelf: 'center' }}>Cannot be sent right now.</span>}
      </div>
    </form>
  )
}

// Shown on the Connection tab once connected. Everything that writes is off while offline:
// nothing here can be queued, least of all a passphrase.
export default function BackupSettings() {
  const { connected, api } = useConnection()
  const offline = useOffline()
  const [state, setState] = useState(null)
  const [error, setError] = useState(null)
  const [form, setForm] = useState(null) // null | 'on' | 'replace'
  const [busy, setBusy] = useState(null)
  const [check, setCheck] = useState(null)
  const [message, setMessage] = useState(null)
  const openButton = useRef(null)

  const load = useCallback(async () => {
    try {
      setState(await api.getBackup())
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [api])

  useEffect(() => { if (connected) load() }, [connected, load])

  // Back up now answers at once and the job runs behind it: look again while it is running.
  const running = Boolean(state?.job?.running)
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(load, 2000)
    return () => clearInterval(timer)
  }, [running, load])

  // The button that opened the form is not on screen while the form is, so focus can only go back
  // to it once the form has gone and the button has been drawn again.
  const returnFocus = useRef(false)
  useEffect(() => {
    if (form === null && returnFocus.current) {
      returnFocus.current = false
      openButton.current?.focus()
    }
  }, [form])

  if (!connected) return null

  async function run(name, action, done) {
    setBusy(name)
    setError(null)
    setMessage(null)
    try {
      const result = await action()
      if (done) done(result)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  function closeForm() {
    returnFocus.current = true
    setForm(null)
  }

  const submitPassphrase = (passphrase) => run('passphrase', () => api.setBackupEncryption(passphrase, form === 'replace'), (next) => {
    setState(next)
    setMessage(form === 'replace'
      ? 'The passphrase is changed. New backups use it.'
      : 'Encryption is on. The next backup will be encrypted.')
    setForm(null)
  })

  const backUpNow = () => run('backup', async () => {
    await api.runSync('backup')
    await load()
  })

  const turnOff = () => run('off', () => api.disableBackupEncryption(), (next) => {
    setState(next)
    setMessage('Encryption is off. New backups will be readable files. Backups already encrypted still need their passphrase.')
  })

  const writeOff = offline || busy !== null
  const newest = state?.newest

  return (
    <section className="card" aria-labelledby="cc-backups-heading" style={{ marginTop: '1.5rem' }}>
      <div className="section-header" id="cc-backups-heading">Backups</div>

      {error && <ErrorBanner message={error} />}
      {!state && !error && <p style={{ fontSize: '0.85rem', color: 'var(--t2)' }}>Loading…</p>}

      {state && (
        <>
          <Row label="Encryption">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600, color: state.encryption ? 'var(--green)' : 'var(--t1)' }}>
              {state.encryption ? <Lock size={14} aria-hidden="true" /> : <LockOpen size={14} aria-hidden="true" />}
              {state.encryption ? 'On' : 'Off'}
            </span>
            {!state.encryption && <span style={{ color: 'var(--t2)' }}> · backups are readable files</span>}
          </Row>
          <Row label="Folder">{state.folder ?? 'None: this server has an in-memory database'}</Row>
          <Row label="Newest copy">
            {newest
              ? `${newest.name} · ${formatBytes(newest.bytes)} · ${new Date(newest.modifiedAt).toLocaleString()}`
              : 'None yet'}
          </Row>
          <Row label="Copies kept">{state.copies} of {state.keep}</Row>
          {state.job && (
            <Row label="Last run">
              {state.job.running ? 'Running now…' : (state.job.lastRunAt ? new Date(state.job.lastRunAt).toLocaleString() : 'Never')}
              {state.job.lastError && <span style={{ color: 'var(--red)' }}> · {state.job.lastError.split('\n')[0]}</span>}
            </Row>
          )}
          {!state.job && (
            <p style={{ fontSize: '0.8rem', color: 'var(--t2)', margin: '0.5rem 0 0' }}>
              This server was started with serve, which runs no jobs, so it makes no backups. The daemon does.
            </p>
          )}

          {state.encryption && state.plainCopies > 0 && (
            <Notice tone="yellow">
              {state.plainCopies} readable {state.plainCopies === 1 ? 'copy is' : 'copies are'} still in the folder from before
              encryption was on. Back up now replaces today&apos;s. The rest age out one a day, or you can delete them from the folder.
            </Notice>
          )}
          {message && <Notice tone="green">{message}</Notice>}
          {offline && <Notice tone="yellow">Offline. Backup settings can be changed when the server is back.</Notice>}

          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1rem' }}>
            {state.job && (
              <button type="button" className="btn" onClick={backUpNow} disabled={writeOff || running}>
                <Play size={14} aria-hidden="true" /> {busy === 'backup' || running ? 'Backing up…' : 'Back up now'}
              </button>
            )}
            <button type="button" className="btn" onClick={() => run('check', () => api.checkBackup(), setCheck)} disabled={writeOff || !newest}>
              <ShieldCheck size={14} aria-hidden="true" /> {busy === 'check' ? 'Checking…' : 'Check newest backup'}
            </button>
          </div>

          {check && check.checked && (
            <Notice tone={check.ok ? 'green' : 'red'}>
              <strong>{check.ok ? 'This backup can be restored.' : 'This backup should not be trusted.'}</strong>{' '}
              {check.name}{check.encrypted ? ', encrypted, and the passphrase opens it' : ''}.
              {check.counts ? ` ${check.counts.tasks} tasks, ${check.counts.projects} projects.` : ''}
              {check.problems?.length > 0 && ` ${check.problems.join(' ')}`}
            </Notice>
          )}
          {check && !check.checked && <Notice tone="yellow">{check.message}</Notice>}

          <div style={{ borderTop: '1px solid var(--bd)', marginTop: '1.25rem', paddingTop: '1rem' }}>
            {form === null && (
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                {!state.encryption && (
                  <button ref={openButton} type="button" className="btn btn-primary" onClick={() => { setForm('on'); setMessage(null) }} disabled={writeOff}>
                    <Lock size={14} aria-hidden="true" /> Turn on encryption
                  </button>
                )}
                {state.encryption && (
                  <>
                    <button ref={openButton} type="button" className="btn" onClick={() => { setForm('replace'); setMessage(null) }} disabled={writeOff}>
                      Change passphrase
                    </button>
                    <ConfirmButton
                      label="Turn off encryption"
                      confirmLabel="Make new backups readable"
                      className="btn btn-danger"
                      onConfirm={turnOff}
                      disabled={writeOff}
                    />
                  </>
                )}
              </div>
            )}
            {form !== null && (
              <PassphraseForm
                replacing={form === 'replace'}
                minLength={state.minPassphraseLength ?? 12}
                busy={busy === 'passphrase'}
                disabled={writeOff}
                onSubmit={submitPassphrase}
                onCancel={closeForm}
              />
            )}
          </div>
        </>
      )}
    </section>
  )
}
