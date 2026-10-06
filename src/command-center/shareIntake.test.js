import { describe, test, expect, afterEach } from 'vitest'
import { parseShareParams, shareToTaskFields, stripShareParams } from './shareIntake'

afterEach(() => window.history.replaceState(null, '', '/'))

describe('parseShareParams', () => {
  test('reads and trims the three parameters', () => {
    expect(parseShareParams('?share-title=%20Hi%20&share-text=Body&share-url=https%3A%2F%2Fa.test')).toEqual({
      title: 'Hi', text: 'Body', url: 'https://a.test',
    })
  })

  test('gives an empty string for a missing one', () => {
    expect(parseShareParams('share-text=Only')).toEqual({ title: '', text: 'Only', url: '' })
  })

  test('is null when none is present or all are blank', () => {
    expect(parseShareParams('')).toBeNull()
    expect(parseShareParams('?view=board')).toBeNull()
    expect(parseShareParams('?share-title=%20&share-text=&share-url=')).toBeNull()
    expect(parseShareParams(undefined)).toBeNull()
  })
})

describe('shareToTaskFields', () => {
  test('uses the title, text as notes, and the url as the link', () => {
    expect(shareToTaskFields({ title: 'T', text: 'Some words', url: 'https://a.test' })).toEqual({
      title: 'T', notes: 'Some words', sourceUrl: 'https://a.test',
    })
  })

  test('finds a link inside the text and removes it from the title', () => {
    const text = 'Great read https://example.com/post.\nSecond line'
    expect(shareToTaskFields({ title: '', text, url: '' })).toEqual({
      title: 'Great read', notes: text, sourceUrl: 'https://example.com/post',
    })
  })

  test('a text that is only a link titles the task with it and leaves notes empty', () => {
    expect(shareToTaskFields({ title: '', text: 'https://example.com/x', url: '' })).toEqual({
      title: 'https://example.com/x', notes: '', sourceUrl: 'https://example.com/x',
    })
  })

  test('text equal to the title is not repeated as notes', () => {
    expect(shareToTaskFields({ title: 'Same', text: 'Same', url: '' }).notes).toBe('')
    expect(shareToTaskFields({ title: '', text: 'Plain note', url: '' })).toEqual({
      title: 'Plain note', notes: '', sourceUrl: null,
    })
  })

  test('a lone url becomes the title, and nothing at all gets a placeholder', () => {
    expect(shareToTaskFields({ title: '', text: '', url: 'https://a.test' }).title).toBe('https://a.test')
    expect(shareToTaskFields({ title: '', text: '', url: '' })).toEqual({ title: 'Shared item', notes: '', sourceUrl: null })
  })
})

describe('stripShareParams', () => {
  test('removes only the share parameters and keeps the others and the hash', () => {
    window.history.replaceState(null, '', '/?view=board&share-title=a&share-text=b&share-url=c&x=1#cc-url=h')
    stripShareParams()
    expect(window.location.search).toBe('?view=board&x=1')
    expect(window.location.hash).toBe('#cc-url=h')
  })

  test('does nothing when there are none', () => {
    window.history.replaceState(null, '', '/?view=board#h')
    stripShareParams()
    expect(window.location.search + window.location.hash).toBe('?view=board#h')
  })
})
