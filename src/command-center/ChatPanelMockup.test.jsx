import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import ChatPanelMockup from './ChatPanelMockup'

let fetchSpy

beforeEach(() => {
  fetchSpy = vi.fn()
  global.fetch = fetchSpy
})

afterEach(() => {
  cleanup()
})

function renderOpen(extra = {}) {
  const onClose = extra.onClose || vi.fn()
  const openButtonRef = extra.openButtonRef || { current: null }
  const utils = render(<ChatPanelMockup open onClose={onClose} openButtonRef={openButtonRef} />)
  return { ...utils, onClose, openButtonRef }
}

function getSuggestionButtons(container) {
  return Array.from(container.querySelectorAll('.chat-suggestion'))
}

describe('ChatPanelMockup closed state', () => {
  test('renders nothing when open is false', () => {
    const { container } = render(
      <ChatPanelMockup open={false} onClose={vi.fn()} openButtonRef={{ current: null }} />
    )
    expect(container.innerHTML).toBe('')
  })

  test('Escape does nothing when closed', () => {
    const onClose = vi.fn()
    render(<ChatPanelMockup open={false} onClose={onClose} openButtonRef={{ current: null }} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('ChatPanelMockup open state basics', () => {
  test('has dialog role and the expected accessible label', () => {
    const { container } = renderOpen()
    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('aria-label')).toBe('Ask Polaris')
  })

  test('shows the empty-state text when there are no messages yet', () => {
    const { container } = renderOpen()
    const empty = container.querySelector('.chat-empty')
    expect(empty).not.toBeNull()
    expect(empty.textContent).toContain('Pick a question below')
  })

  test('the dictate button is disabled', () => {
    const { container } = renderOpen()
    const dictate = container.querySelector('button[aria-label="Dictate (not built in the mockup)"]')
    expect(dictate).not.toBeNull()
    expect(dictate.disabled).toBe(true)
  })

  test('the Send button is disabled while the draft is empty', () => {
    const { container } = renderOpen()
    const send = container.querySelector('button[aria-label="Send"]')
    expect(send.disabled).toBe(true)
  })
})

describe('ChatPanelMockup canned suggestions', () => {
  test('the overdue suggestion produces the question bubble and 3 rows with no Apply button', () => {
    const { container } = renderOpen()
    const [overdueBtn] = getSuggestionButtons(container)
    fireEvent.click(overdueBtn)

    const question = container.querySelector('.chat-question')
    expect(question.textContent).toBe('What is overdue for the studio?')

    const summary = container.querySelector('.chat-reply-summary')
    expect(summary.textContent).toBe('3 overdue tasks in studio projects')

    const rows = container.querySelectorAll('.chat-row')
    expect(rows.length).toBe(3)

    const applyButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent.includes('Apply')
    )
    expect(applyButtons.length).toBe(0)
  })

  test('the week suggestion produces 2 rows', () => {
    const { container } = renderOpen()
    const [, , weekBtn] = getSuggestionButtons(container)
    fireEvent.click(weekBtn)

    const summary = container.querySelector('.chat-reply-summary')
    expect(summary.textContent).toBe('2 tasks due this week')

    const rows = container.querySelectorAll('.chat-row')
    expect(rows.length).toBe(2)
  })

  test('the move suggestion produces a proposal with 3 rows, Gmail badges, withheld titles, range due text and Apply/Discard buttons', () => {
    const { container } = renderOpen()
    const [, moveBtn] = getSuggestionButtons(container)
    fireEvent.click(moveBtn)

    const question = container.querySelector('.chat-question')
    expect(question.textContent).toBe('Move everything from the client email to Friday')

    const summary = container.querySelector('.chat-reply-summary')
    expect(summary.textContent).toBe('Set the due date to Fri, Sep 25 on 3 tasks from the client email')

    const rows = container.querySelectorAll('.chat-row')
    expect(rows.length).toBe(3)

    const sourceBadges = container.querySelectorAll('.chat-badge-source')
    expect(sourceBadges.length).toBe(3)
    sourceBadges.forEach((badge) => expect(badge.textContent).toBe('Gmail'))

    const titles = container.querySelectorAll('.chat-row-title')
    titles.forEach((t) => expect(t.textContent).toBe('Task from Gmail (open to read)'))

    const dueTexts = Array.from(container.querySelectorAll('.chat-due')).map((el) => el.textContent)
    expect(dueTexts).toContain('Sep 21 to Sep 25')

    const applyBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Apply to 3 tasks')
    )
    const discardBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Discard')
    expect(applyBtn).not.toBeUndefined()
    expect(discardBtn).not.toBeUndefined()
  })
})

describe('ChatPanelMockup typed question routing', () => {
  function ask(container, text) {
    const textarea = container.querySelector('textarea')
    fireEvent.change(textarea, { target: { value: text } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
  }

  test('a typed question containing "overdue" (any case) routes to the overdue reply', () => {
    const { container } = renderOpen()
    ask(container, 'what is OVERDUE right now')
    const summary = container.querySelector('.chat-reply-summary')
    expect(summary.textContent).toBe('3 overdue tasks in studio projects')
  })

  test('a typed question containing "move" routes to the move reply', () => {
    const { container } = renderOpen()
    ask(container, 'please MOVE those tasks')
    const summary = container.querySelector('.chat-reply-summary')
    expect(summary.textContent).toBe('Set the due date to Fri, Sep 25 on 3 tasks from the client email')
  })

  test('a typed question containing "friday" routes to the move reply', () => {
    const { container } = renderOpen()
    ask(container, 'can this happen by Friday')
    const summary = container.querySelector('.chat-reply-summary')
    expect(summary.textContent).toBe('Set the due date to Fri, Sep 25 on 3 tasks from the client email')
  })

  test('a typed question containing "week" routes to the week reply', () => {
    const { container } = renderOpen()
    ask(container, 'what is due this WEEK')
    const summary = container.querySelector('.chat-reply-summary')
    expect(summary.textContent).toBe('2 tasks due this week')
  })

  test('an unrecognized question gets the fallback note', () => {
    const { container } = renderOpen()
    ask(container, 'tell me a joke')
    const summary = container.querySelector('.chat-reply-summary')
    expect(summary.textContent).toBe('This is a mockup, so only the three suggested questions have an answer.')
    const rows = container.querySelectorAll('.chat-row')
    expect(rows.length).toBe(0)
  })
})

describe('ChatPanelMockup input handling', () => {
  test('whitespace-only input sends nothing', () => {
    const { container } = renderOpen()
    const textarea = container.querySelector('textarea')
    fireEvent.change(textarea, { target: { value: '   ' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(container.querySelectorAll('.chat-question').length).toBe(0)
    expect(container.querySelector('.chat-empty')).not.toBeNull()
  })

  test('the Send button stays disabled for whitespace-only input', () => {
    const { container } = renderOpen()
    const textarea = container.querySelector('textarea')
    fireEvent.change(textarea, { target: { value: '   ' } })
    const send = container.querySelector('button[aria-label="Send"]')
    expect(send.disabled).toBe(true)
  })

  test('the Send button becomes enabled once real text is entered', () => {
    const { container } = renderOpen()
    const textarea = container.querySelector('textarea')
    fireEvent.change(textarea, { target: { value: 'hello there' } })
    const send = container.querySelector('button[aria-label="Send"]')
    expect(send.disabled).toBe(false)
  })

  test('Enter submits the question', () => {
    const { container } = renderOpen()
    const textarea = container.querySelector('textarea')
    fireEvent.change(textarea, { target: { value: 'what is due this week' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(container.querySelectorAll('.chat-question').length).toBe(1)
  })

  test('Shift+Enter does not submit the question', () => {
    const { container } = renderOpen()
    const textarea = container.querySelector('textarea')
    fireEvent.change(textarea, { target: { value: 'what is due this week' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(container.querySelectorAll('.chat-question').length).toBe(0)
  })

  test('the draft clears after sending', () => {
    const { container } = renderOpen()
    const textarea = container.querySelector('textarea')
    fireEvent.change(textarea, { target: { value: 'what is due this week' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(textarea.value).toBe('')
  })
})

describe('ChatPanelMockup proposal resolution', () => {
  function clickMove(container) {
    const [, moveBtn] = getSuggestionButtons(container)
    fireEvent.click(moveBtn)
  }

  test('Apply switches to the applied text and removes both action buttons', () => {
    const { container } = renderOpen()
    clickMove(container)
    const applyBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Apply to 3 tasks')
    )
    fireEvent.click(applyBtn)

    const result = container.querySelector('.chat-proposal-result')
    expect(result.textContent).toBe('Applied (mockup: nothing was written).')

    const remainingApply = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Apply to 3 tasks')
    )
    const remainingDiscard = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Discard'
    )
    expect(remainingApply).toBeUndefined()
    expect(remainingDiscard).toBeUndefined()
  })

  test('Discard switches to the discarded text and removes both action buttons', () => {
    const { container } = renderOpen()
    clickMove(container)
    const discardBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Discard')
    fireEvent.click(discardBtn)

    const result = container.querySelector('.chat-proposal-result')
    expect(result.textContent).toBe('Discarded. Nothing was changed.')

    const remainingApply = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Apply to 3 tasks')
    )
    expect(remainingApply).toBeUndefined()
  })

  test('resolving one proposal does not affect a second proposal in the same conversation', () => {
    // A frozen clock: message ids must stay unique even when two questions are asked within
    // the same millisecond.
    vi.spyOn(Date, 'now').mockReturnValue(1000)

    const { container } = renderOpen()
    const [, moveBtn] = getSuggestionButtons(container)
    fireEvent.click(moveBtn)
    fireEvent.click(moveBtn)

    const replies = container.querySelectorAll('.chat-reply')
    expect(replies.length).toBe(2)

    const firstApply = replies[0].querySelector('.btn-primary')
    fireEvent.click(firstApply)

    expect(replies[0].querySelector('.chat-proposal-result').textContent).toBe(
      'Applied (mockup: nothing was written).'
    )
    expect(replies[1].querySelector('.chat-proposal-result')).toBeNull()
    expect(replies[1].querySelector('.btn-primary')).not.toBeNull()
    expect(replies[1].querySelector('.btn-primary').textContent).toContain('Apply to 3 tasks')
  })
})

describe('ChatPanelMockup keyboard and focus behaviour', () => {
  test('Escape calls onClose while open', () => {
    const onClose = vi.fn()
    renderOpen({ onClose })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('focus moves into the panel on open', () => {
    const { container } = renderOpen()
    const firstButton = container.querySelector('button')
    expect(document.activeElement).toBe(firstButton)
  })

  test('focus returns to the element in openButtonRef when open goes from true to false', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    const openButtonRef = { current: opener }
    const onClose = vi.fn()

    const { rerender } = render(<ChatPanelMockup open onClose={onClose} openButtonRef={openButtonRef} />)
    rerender(<ChatPanelMockup open={false} onClose={onClose} openButtonRef={openButtonRef} />)

    expect(document.activeElement).toBe(opener)
    document.body.removeChild(opener)
  })

  test('Tab from the last focusable wraps to the first', () => {
    const { container } = renderOpen()
    const focusables = Array.from(container.querySelectorAll('button:not(:disabled), textarea'))
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
  })

  test('Shift+Tab from the first focusable wraps to the last', () => {
    const { container } = renderOpen()
    const focusables = Array.from(container.querySelectorAll('button:not(:disabled), textarea'))
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
})

describe('ChatPanelMockup never calls the network', () => {
  test('fetch is never called across suggestion clicks, typing, apply and discard', () => {
    const { container } = renderOpen()
    const [overdueBtn, moveBtn, weekBtn] = getSuggestionButtons(container)
    fireEvent.click(overdueBtn)
    fireEvent.click(weekBtn)
    fireEvent.click(moveBtn)

    const textarea = container.querySelector('textarea')
    fireEvent.change(textarea, { target: { value: 'anything at all' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    const applyBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Apply to 3 tasks')
    )
    fireEvent.click(applyBtn)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
