import { describe, test, expect, vi } from 'vitest'
import { dropUntouchedNext } from './repeatUndo'

const made = { id: 'n', status: 'open', updatedAt: '2026-11-14T10:00:00.000Z' }

function fakeApi(current) {
  return {
    getTask: vi.fn(async () => (current instanceof Error ? Promise.reject(current) : { task: current })),
    updateTask: vi.fn().mockResolvedValue({ task: {} }),
  }
}

describe('dropUntouchedNext', () => {
  test('drops a copy that is as it was made', async () => {
    const api = fakeApi({ ...made })
    await dropUntouchedNext(api, made)
    expect(api.updateTask).toHaveBeenCalledWith('n', { status: 'dropped' })
  })

  test('leaves a copy edited since it was made', async () => {
    const api = fakeApi({ ...made, title: 'Renamed', updatedAt: '2026-11-14T10:00:05.000Z' })
    await dropUntouchedNext(api, made)
    expect(api.updateTask).not.toHaveBeenCalled()
  })

  test('leaves a copy already done or dropped', async () => {
    for (const status of ['done', 'dropped', 'in_progress']) {
      const api = fakeApi({ ...made, status })
      await dropUntouchedNext(api, made)
      expect(api.updateTask).not.toHaveBeenCalled()
    }
  })

  test('does nothing for a task that made no copy', async () => {
    const api = fakeApi({ ...made })
    await dropUntouchedNext(api, null)
    expect(api.getTask).not.toHaveBeenCalled()
  })

  test('a copy that cannot be read, or a failed drop, does not fail the Undo', async () => {
    await expect(dropUntouchedNext(fakeApi(new Error('offline')), made)).resolves.toBeUndefined()
    const api = fakeApi({ ...made })
    api.updateTask.mockRejectedValueOnce(new Error('down'))
    await expect(dropUntouchedNext(api, made)).resolves.toBeUndefined()
  })
})
