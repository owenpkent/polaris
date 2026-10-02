import { useCallback, useEffect, useRef } from 'react'
import { MY_TASKS_QUERY } from './api'
import { useConnection } from './ConnectionContext'
import { cacheGet } from './offlineCache'
import { getOfflineState } from './offlineStatus'
import { useEventRefresh } from './useEvents'

// Keeps the local copy complete. api.js stores every response a view happens to ask for, which
// alone would leave a tab that has not been opened on this device empty when the server goes
// away. So on connect, and again whenever the server's data changes, this asks for everything
// the tabs read. The answers are thrown away here: being stored by api.js is the point.

const CONCURRENCY = 4
const EVENT_PAGE = 200

async function runAll(jobs) {
  const queue = [...jobs]
  const worker = async () => {
    while (queue.length) {
      // One failure (GitHub not signed in, a task dropped mid-run) must not stop the rest.
      try { await queue.shift()() } catch { /* next */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
}

export function useMirrorWarm() {
  const { connected, api, baseUrl } = useConnection()
  const running = useRef(false)
  const again = useRef(false)
  const eventCursor = useRef(null)

  const warm = useCallback(async () => {
    if (running.current) {
      again.current = true
      return
    }
    running.current = true
    try {
      // Task ids named by events since the last run. Their detail is reloaded even when the
      // task's own updatedAt did not move, which is the case for a new comment.
      const touched = new Set()
      const first = eventCursor.current === null
      const events = await api.getEvents(first ? undefined : eventCursor.current, first ? 1 : EVENT_PAGE)
      if (!first) (events.events || []).forEach((e) => { if (e.taskId) touched.add(e.taskId) })
      if (typeof events.headId === 'number') eventCursor.current = events.headId

      const lists = {}
      await runAll([
        async () => { lists.projects = (await api.listProjects()).projects || [] },
        async () => { lists.tasks = (await api.listTasks(MY_TASKS_QUERY)).tasks || [] },
        async () => { lists.goals = (await api.listGoals(false)).goals || [] },
        () => api.listProjects({ includeArchived: true }),
        () => api.listGoals(true),
        () => api.listInbox(),
        () => api.listRules(),
        // The two views behind the Readiness filter on My tasks.
        () => api.getView('ready'),
        () => api.getView('blocked'),
        () => api.getDigest(),
        () => api.getSync(),
        () => api.githubStatus(),
        () => api.githubRepos(),
      ])
      // Offline, those answers came from the copy itself: there is nothing newer to fetch.
      if (getOfflineState().offline) return

      const trimmed = (baseUrl || '').replace(/\/+$/, '')
      const stale = []
      for (const task of lists.tasks || []) {
        const cached = touched.has(task.id) ? null : await cacheGet(`${trimmed}/api/tasks/${encodeURIComponent(task.id)}`)
        if (cached?.data?.task?.updatedAt !== task.updatedAt) stale.push(task.id)
      }
      await runAll([
        ...(lists.projects || []).map((p) => () => api.getProject(p.id)),
        ...(lists.goals || []).map((g) => () => api.getGoal(g.id)),
        ...stale.map((id) => () => api.getTask(id)),
      ])
    } catch {
      // The server went away part way through. The next change, or coming back online, reruns it.
    } finally {
      running.current = false
      if (again.current) {
        again.current = false
        warm()
      }
    }
  }, [api, baseUrl])

  useEffect(() => {
    if (!connected) return
    eventCursor.current = null
    warm()
  }, [connected, warm])

  useEventRefresh(warm, { enabled: connected })
}
