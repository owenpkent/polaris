import { describe, test, expect, vi, afterEach } from 'vitest'
import { subscribeNativeShares } from './nativeApp'

afterEach(() => {
  delete window.Capacitor
})

function fakeCapacitor() {
  const remove = vi.fn()
  let captured = null
  const addListener = vi.fn((plugin, event, cb) => {
    captured = cb
    return { remove }
  })
  window.Capacitor = { isNativePlatform: () => true, addListener }
  return { addListener, remove, fire: (url) => captured({ url }) }
}

describe('subscribeNativeShares', () => {
  test('does nothing outside the app', () => {
    expect(() => subscribeNativeShares(() => {})()).not.toThrow()
  })

  test('does nothing when the bridge has no addListener', () => {
    window.Capacitor = { isNativePlatform: () => true }
    expect(() => subscribeNativeShares(() => {})()).not.toThrow()
  })

  test('parses the opened url and hands over the share', () => {
    const cap = fakeCapacitor()
    const onShare = vi.fn()
    subscribeNativeShares(onShare)
    expect(cap.addListener).toHaveBeenCalledWith('App', 'appUrlOpen', expect.any(Function))
    cap.fire('polaris://share?share-text=Hello&share-url=https%3A%2F%2Fa.test')
    expect(onShare).toHaveBeenCalledWith({ title: '', text: 'Hello', url: 'https://a.test' })
  })

  test('ignores a url with no share and one that does not parse', () => {
    const cap = fakeCapacitor()
    const onShare = vi.fn()
    subscribeNativeShares(onShare)
    cap.fire('polaris://open?view=board')
    cap.fire('not a url')
    expect(onShare).not.toHaveBeenCalled()
  })

  test('unsubscribing removes the listener', () => {
    const cap = fakeCapacitor()
    subscribeNativeShares(() => {})()
    expect(cap.remove).toHaveBeenCalledTimes(1)
  })
})
