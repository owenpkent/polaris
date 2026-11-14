import { describe, test, expect, vi } from 'vitest'
import { dropUntouchedNext } from './repeatUndo'

const made = { id: 'n', status: 'open', updatedAt: '2026-11-14T10:00:00.000Z' }

describe('dropUntouchedNext', () => {
  test('asks the server to drop the copy only while it is as it was made', async () => {
    const api = { updateTaskIfUnchanged: vi.fn().mockResolvedValue({ task: {} }) }
    await dropUntouchedNext(api, made)
    expect(api.updateTaskIfUnchanged).toHaveBeenCalledWith('n', { status: 'dropped' }, made.updatedAt)
  })

  test('does nothing for a task that made no copy, or a copy with no stamp to check', async () => {
    const api = { updateTaskIfUnchanged: vi.fn() }
    await dropUntouchedNext(api, null)
    await dropUntouchedNext(api, { id: 'n' })
    expect(api.updateTaskIfUnchanged).not.toHaveBeenCalled()
  })

  // A copy changed since (409), or a server out of reach: the reopen still counts.
  test('a refused or failed drop does not fail the Undo', async () => {
    const api = { updateTaskIfUnchanged: vi.fn().mockRejectedValue(new Error('The task has changed since it was read.')) }
    await expect(dropUntouchedNext(api, made)).resolves.toBeUndefined()
  })
})
