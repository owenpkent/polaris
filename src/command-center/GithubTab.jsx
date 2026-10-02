import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, CheckCircle2, Circle } from 'lucide-react'
import { useConnection } from './ConnectionContext'
import { useOffline } from './offlineStatus'
import NotConnected from './NotConnected'
import { Loading, ErrorBanner, ConfirmButton, formatDate } from './shared'

const stepButton = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 44,
  padding: '0 18px',
  borderRadius: 8,
  border: '1px solid var(--bd-strong)',
  background: 'var(--bg3)',
  color: 'var(--t1)',
  fontSize: 14,
  cursor: 'pointer',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
}

const stepButtonPrimary = {
  ...stepButton,
  background: 'var(--blue)',
  borderColor: 'var(--blue)',
  color: 'var(--on-accent)',
  fontWeight: 600,
}

const stepButtonDisabled = {
  ...stepButton,
  opacity: 0.5,
  cursor: 'default',
}

const secondaryButton = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 44,
  padding: '0 14px',
  borderRadius: 8,
  border: '1px solid var(--bd-strong)',
  background: 'transparent',
  color: 'var(--t2)',
  fontSize: 13,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const thStyle = {
  textAlign: 'left',
  padding: '8px',
  fontSize: 12,
  color: 'var(--t2)',
  fontWeight: 600,
}

function errorMessage(err, fallback) {
  return (err && err.message) || fallback
}

function AccessLine({ status }) {
  if (!status) return null
  if (status.mode === 'app' && status.signedIn) {
    return (
      <p style={{ color: 'var(--green)', fontSize: 14, margin: '6px 0 0' }}>
        Read-only, signed in as {status.user?.login}.
      </p>
    )
  }
  return <p style={{ color: 'var(--t2)', fontSize: 14, margin: '6px 0 0' }}>Not connected.</p>
}

function StepRow({ number, title, done, helperText, children }) {
  return (
    <div style={{ padding: '16px 0', borderBottom: '1px solid var(--bd)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span
          aria-hidden="true"
          style={{
            width: 24,
            height: 24,
            borderRadius: '50%',
            border: '1px solid var(--bd)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--t2)',
            flexShrink: 0,
          }}
        >
          {number}
        </span>
        <span style={{ fontWeight: 600, fontSize: 15, flex: '1 1 220px' }}>{title}</span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            fontWeight: 600,
            color: done ? 'var(--green)' : 'var(--t2)',
            minWidth: 60,
          }}
        >
          {done ? <CheckCircle2 size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}
          {done ? 'Done' : 'To do'}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {children}
        </div>
      </div>
      {helperText && (
        <p style={{ margin: '8px 0 0 38px', fontSize: 13, color: 'var(--t2)' }}>{helperText}</p>
      )}
    </div>
  )
}

function ToggleSwitch({ checked, onChange, label, disabled }) {
  const offline = useOffline()
  const isDisabled = disabled || offline
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={isDisabled}
      onClick={() => onChange(!checked)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 44,
        minWidth: 44,
        padding: '0 10px',
        border: '1px solid var(--bd-strong)',
        borderRadius: 8,
        background: 'transparent',
        cursor: isDisabled ? 'default' : 'pointer',
        opacity: isDisabled ? 0.5 : 1,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 32,
          height: 18,
          borderRadius: 10,
          background: checked ? 'var(--green)' : 'var(--bd)',
          position: 'relative',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 16 : 2,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: 'var(--t1)',
          }}
        />
      </span>
      <span style={{ fontSize: 13, color: 'var(--t1)' }}>{checked ? 'On' : 'Off'}</span>
    </button>
  )
}

function RepoRow({ repo, error, onToggle }) {
  const tracked = Boolean(repo.tracked)
  return (
    <>
      <tr style={{ borderBottom: '1px solid var(--bd)' }}>
        <td style={{ padding: '8px' }}>{repo.fullName}</td>
        <td style={{ padding: '8px', color: 'var(--t2)' }}>{repo.private ? 'Private' : 'Public'}</td>
        <td style={{ padding: '8px', color: 'var(--t2)' }}>{repo.project?.name || ''}</td>
        <td style={{ padding: '8px' }}>
          <ToggleSwitch
            checked={tracked}
            onChange={(next) => onToggle(repo.fullName, 'tracked', next)}
            label={`Track ${repo.fullName} as a project`}
          />
        </td>
        <td style={{ padding: '8px' }}>
          <ToggleSwitch
            checked={Boolean(repo.syncIssues)}
            onChange={(next) => onToggle(repo.fullName, 'syncIssues', next)}
            label={`Sync issues and PRs for ${repo.fullName}`}
            disabled={!tracked}
          />
        </td>
        <td style={{ padding: '8px' }}>
          <ToggleSwitch
            checked={Boolean(repo.readChecklists)}
            onChange={(next) => onToggle(repo.fullName, 'readChecklists', next)}
            label={`Read checklists for ${repo.fullName}`}
            disabled={!tracked}
          />
        </td>
      </tr>
      {!tracked && (
        <tr>
          <td colSpan={6} style={{ padding: '0 8px 10px', color: 'var(--t2)', fontSize: 12 }}>
            Sync issues and read checklists apply once {repo.fullName} is tracked as a project.
          </td>
        </tr>
      )}
      {error && (
        <tr>
          <td colSpan={6} style={{ padding: '0 8px 10px', color: 'var(--red)', fontSize: 13 }}>
            {error}
          </td>
        </tr>
      )}
    </>
  )
}

export default function GithubTab() {
  const { connected, api } = useConnection()
  const offline = useOffline()

  const [status, setStatus] = useState(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState(null)

  const [repos, setRepos] = useState([])
  const [reposLoading, setReposLoading] = useState(false)
  const [reposError, setReposError] = useState(null)
  const [rowErrors, setRowErrors] = useState({})
  const [filterText, setFilterText] = useState('')

  const [appBusy, setAppBusy] = useState(false)
  const [appError, setAppError] = useState(null)
  const [signinBusy, setSigninBusy] = useState(false)
  const [signinError, setSigninError] = useState(null)
  const [signoutBusy, setSignoutBusy] = useState(false)
  const [signoutError, setSignoutError] = useState(null)

  const fetchStatus = useCallback(async () => {
    setStatusError(null)
    try {
      const res = await api.githubStatus()
      setStatus(res)
    } catch (err) {
      setStatusError(errorMessage(err, 'Could not load GitHub status.'))
    } finally {
      setStatusLoading(false)
    }
  }, [api])

  const fetchRepos = useCallback(async () => {
    setReposError(null)
    setReposLoading(true)
    try {
      const res = await api.githubRepos()
      setRepos(res.repos || [])
    } catch (err) {
      setReposError(errorMessage(err, 'Could not load repos.'))
    } finally {
      setReposLoading(false)
    }
  }, [api])

  useEffect(() => {
    if (!connected) return
    setStatusLoading(true)
    fetchStatus()
  }, [connected, fetchStatus])

  useEffect(() => {
    if (!connected || !status?.signedIn) return
    fetchRepos()
  }, [connected, status?.signedIn, fetchRepos])

  // Returning to this tab from GitHub (creating the app, installing it,
  // signing in) all happen in another tab. Refetch on focus so the steps
  // update without a manual refresh.
  useEffect(() => {
    if (!connected) return undefined
    function handleFocus() {
      fetchStatus()
      if (status?.signedIn) fetchRepos()
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [connected, fetchStatus, fetchRepos, status?.signedIn])

  async function handleCreateApp() {
    setAppBusy(true)
    setAppError(null)
    try {
      const res = await api.githubAppManifest()
      const form = document.createElement('form')
      form.method = 'POST'
      form.action = res.action
      form.target = '_blank'
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = 'manifest'
      input.value = res.manifest
      form.appendChild(input)
      document.body.appendChild(form)
      form.submit()
      document.body.removeChild(form)
    } catch (err) {
      setAppError(
        err.code === 'github_app_exists'
          ? 'A GitHub App is already registered.'
          : errorMessage(err, 'Could not start creating the GitHub App.')
      )
    } finally {
      setAppBusy(false)
      fetchStatus()
    }
  }

  async function handleForgetApp() {
    setAppBusy(true)
    setAppError(null)
    try {
      await api.githubForgetApp()
      await fetchStatus()
    } catch (err) {
      setAppError(errorMessage(err, 'Could not remove the app.'))
    } finally {
      setAppBusy(false)
    }
  }

  async function handleSignIn() {
    setSigninBusy(true)
    setSigninError(null)
    try {
      const res = await api.githubLogin()
      window.open(res.url, '_blank', 'noopener')
    } catch (err) {
      setSigninError(
        err.code === 'github_app_missing'
          ? 'Create the GitHub App first.'
          : errorMessage(err, 'Could not start sign-in.')
      )
    } finally {
      setSigninBusy(false)
      fetchStatus()
    }
  }

  async function handleSignOut() {
    setSignoutBusy(true)
    setSignoutError(null)
    try {
      await api.githubLogout()
      await fetchStatus()
    } catch (err) {
      setSignoutError(errorMessage(err, 'Could not sign out.'))
    } finally {
      setSignoutBusy(false)
    }
  }

  const handleToggle = useCallback(
    async (fullName, field, next) => {
      setRepos((prev) => prev.map((r) => (r.fullName === fullName ? { ...r, [field]: next } : r)))
      setRowErrors((prev) => {
        const copy = { ...prev }
        delete copy[fullName]
        return copy
      })
      try {
        const res = await api.updateGithubRepo(fullName, { [field]: next })
        setRepos((prev) => prev.map((r) => (r.fullName === fullName ? { ...r, ...res.repo } : r)))
      } catch (err) {
        setRepos((prev) => prev.map((r) => (r.fullName === fullName ? { ...r, [field]: !next } : r)))
        setRowErrors((prev) => ({
          ...prev,
          [fullName]: errorMessage(err, 'Could not update that repo.'),
        }))
      }
    },
    [api]
  )

  function handleRefresh() {
    fetchStatus()
    if (status?.signedIn) fetchRepos()
  }

  if (!connected) return <NotConnected />

  const filteredRepos = repos.filter((r) =>
    r.fullName.toLowerCase().includes(filterText.trim().toLowerCase())
  )

  return (
    <div>
      <p style={{ fontSize: 14, color: 'var(--t2)', margin: 0 }}>
        Polaris reads GitHub with read-only access to the repos you choose.
      </p>

      {statusLoading && !status ? (
        <div style={{ marginTop: 24 }}>
          <Loading label="Loading GitHub status…" />
        </div>
      ) : (
        <>
          <AccessLine status={status} />
          <ErrorBanner message={statusError} onRetry={fetchStatus} />
          {status?.error && <ErrorBanner message={status.error} />}

          <div style={{ marginTop: 20 }}>
            <StepRow
              number={1}
              title="Create the app on GitHub"
              done={Boolean(status?.app)}
              helperText="GitHub opens in a new tab. Click Create GitHub App there, then choose where to install it."
            >
              {status?.app ? (
                <>
                  <a
                    href={status.app.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      minHeight: 44,
                      display: 'inline-flex',
                      alignItems: 'center',
                      color: 'var(--blue)',
                      fontSize: 14,
                    }}
                  >
                    {status.app.name}
                  </a>
                  <ConfirmButton
                    label="Remove app"
                    confirmLabel="Confirm remove"
                    onConfirm={handleForgetApp}
                    disabled={offline}
                    style={{ minHeight: 44, padding: '0 14px', fontSize: 13 }}
                  />
                </>
              ) : (
                <button
                  type="button"
                  style={appBusy || offline ? stepButtonDisabled : stepButtonPrimary}
                  onClick={handleCreateApp}
                  disabled={appBusy || offline}
                >
                  {appBusy ? 'Opening…' : 'Create app'}
                </button>
              )}
            </StepRow>
            {appError && (
              <p style={{ color: 'var(--red)', fontSize: 13, margin: '8px 0 0 38px' }}>{appError}</p>
            )}

            <StepRow
              number={2}
              title="Install it and pick repos"
              done={(status?.installations || []).length > 0}
              helperText="Install it on your account and on any organization whose repos you want. Choose Only select repositories and tick the ones Polaris may read."
            >
              {status?.app?.installUrl ? (
                <a href={status.app.installUrl} target="_blank" rel="noopener noreferrer" style={stepButtonPrimary}>
                  Install on GitHub
                </a>
              ) : (
                <button type="button" style={stepButtonDisabled} disabled>
                  Install on GitHub
                </button>
              )}
            </StepRow>

            <StepRow number={3} title="Sign in" done={Boolean(status?.signedIn)}>
              {status?.signedIn ? (
                <>
                  <span style={{ fontSize: 14, color: 'var(--t1)' }}>
                    Signed in as {status.user?.login}
                    {status.refreshExpiresAt ? ` · expires ${formatDate(status.refreshExpiresAt)}` : ''}
                  </span>
                  <button type="button" style={secondaryButton} onClick={handleSignOut} disabled={signoutBusy || offline}>
                    {signoutBusy ? 'Signing out…' : 'Sign out'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  style={signinBusy || !status?.app || offline ? stepButtonDisabled : stepButtonPrimary}
                  onClick={handleSignIn}
                  disabled={signinBusy || !status?.app || offline}
                >
                  {signinBusy ? 'Opening…' : 'Sign in with GitHub'}
                </button>
              )}
            </StepRow>
            {signinError && (
              <p style={{ color: 'var(--red)', fontSize: 13, margin: '8px 0 0 38px' }}>{signinError}</p>
            )}
            {signoutError && (
              <p style={{ color: 'var(--red)', fontSize: 13, margin: '8px 0 0 38px' }}>{signoutError}</p>
            )}
          </div>

          {status?.signedIn && (status?.installations || []).length > 0 && (
            <div style={{ marginTop: 28 }}>
              <h2
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--t2)',
                  margin: '0 0 8px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                Installations
              </h2>
              {status.installations.map((inst) => (
                <div
                  key={inst.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    padding: '10px 0',
                    borderBottom: '1px solid var(--bd)',
                    flexWrap: 'wrap',
                  }}
                >
                  <span style={{ fontSize: 14, flex: '1 1 160px' }}>{inst.account?.login}</span>
                  <span style={{ fontSize: 13, color: 'var(--t2)', flex: '0 0 110px' }}>
                    {inst.account?.type === 'Organization' ? 'Organization' : 'Personal'}
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--t2)', flex: '0 0 130px' }}>
                    {inst.repositorySelection === 'all' ? 'All repos' : 'Selected repos'}
                  </span>
                  <a
                    href={inst.manageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      minHeight: 44,
                      display: 'inline-flex',
                      alignItems: 'center',
                      color: 'var(--blue)',
                      fontSize: 13,
                    }}
                  >
                    Change repos on GitHub
                  </a>
                </div>
              ))}
            </div>
          )}

          {status?.signedIn && (
            <div style={{ marginTop: 28 }}>
              <p style={{ fontSize: 13, color: 'var(--t2)', margin: '0 0 12px' }}>
                A repo becomes a project when you switch on Track as project. Switching it off
                archives the project and keeps its tasks.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder="Filter repos by name"
                  aria-label="Filter repos by name"
                  style={{ minHeight: 44, padding: '0 12px', flex: '1 1 220px', fontSize: 14 }}
                />
                <button type="button" style={stepButton} onClick={handleRefresh}>
                  <RefreshCw size={14} aria-hidden="true" style={{ marginRight: 6 }} /> Refresh
                </button>
              </div>

              <ErrorBanner message={reposError} onRetry={fetchRepos} />

              {reposLoading && repos.length === 0 ? (
                <Loading label="Loading repos…" />
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                        <th style={thStyle}>Repo</th>
                        <th style={thStyle}>Private or Public</th>
                        <th style={thStyle}>Project</th>
                        <th style={thStyle}>Track as project</th>
                        <th style={thStyle}>Sync issues and PRs</th>
                        <th style={thStyle}>Read checklists</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRepos.map((repo) => (
                        <RepoRow
                          key={repo.fullName}
                          repo={repo}
                          error={rowErrors[repo.fullName]}
                          onToggle={handleToggle}
                        />
                      ))}
                      {filteredRepos.length === 0 && (
                        <tr>
                          <td colSpan={6} style={{ padding: '16px 8px', color: 'var(--t2)' }}>
                            No repos match.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              <p style={{ fontSize: 13, color: 'var(--t2)', marginTop: 16 }}>
                Turning a switch off stops new updates from that repo. Changing which repos the app
                can read happens on GitHub.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
