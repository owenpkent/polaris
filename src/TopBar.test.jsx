import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import TopBar from './TopBar'

// The update icon asks the server through the connection; it has its own tests in UpdateButton.test.jsx.
vi.mock('./UpdateButton', () => ({ default: () => null }))

afterEach(() => {
  cleanup()
})

describe('TopBar title', () => {
  test('renders the given title text', () => {
    const { container } = render(<TopBar title="My Tasks" onMenuClick={vi.fn()} menuOpen={false} />)
    expect(container.querySelector('h1').textContent).toBe('My Tasks')
  })
})

describe('TopBar menu button', () => {
  test('has the expected aria-label', () => {
    const { container } = render(<TopBar title="X" onMenuClick={vi.fn()} menuOpen={false} />)
    const button = container.querySelector('button[aria-label="Open navigation"]')
    expect(button).not.toBeNull()
  })

  test('aria-expanded reflects the menuOpen prop', () => {
    const { container, rerender } = render(<TopBar title="X" onMenuClick={vi.fn()} menuOpen={false} />)
    const button = container.querySelector('button[aria-label="Open navigation"]')
    expect(button.getAttribute('aria-expanded')).toBe('false')

    rerender(<TopBar title="X" onMenuClick={vi.fn()} menuOpen />)
    expect(container.querySelector('button[aria-label="Open navigation"]').getAttribute('aria-expanded')).toBe(
      'true'
    )
  })

  test('calls onMenuClick when clicked', () => {
    const onMenuClick = vi.fn()
    const { container } = render(<TopBar title="X" onMenuClick={onMenuClick} menuOpen={false} />)
    const button = container.querySelector('button[aria-label="Open navigation"]')
    fireEvent.click(button)
    expect(onMenuClick).toHaveBeenCalledTimes(1)
  })
})

describe('TopBar chat button', () => {
  test('is absent when onChatClick is undefined', () => {
    const { container } = render(<TopBar title="X" onMenuClick={vi.fn()} menuOpen={false} />)
    expect(container.querySelector('button[aria-label="Ask Polaris"]')).toBeNull()
  })

  test('is present with the correct aria-expanded when onChatClick is provided', () => {
    const { container } = render(
      <TopBar title="X" onMenuClick={vi.fn()} menuOpen={false} onChatClick={vi.fn()} chatOpen />
    )
    const button = container.querySelector('button[aria-label="Ask Polaris"]')
    expect(button).not.toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })

  test('aria-expanded is false when chatOpen is false', () => {
    const { container } = render(
      <TopBar title="X" onMenuClick={vi.fn()} menuOpen={false} onChatClick={vi.fn()} chatOpen={false} />
    )
    const button = container.querySelector('button[aria-label="Ask Polaris"]')
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  test('calls onChatClick when clicked', () => {
    const onChatClick = vi.fn()
    const { container } = render(
      <TopBar title="X" onMenuClick={vi.fn()} menuOpen={false} onChatClick={onChatClick} chatOpen={false} />
    )
    const button = container.querySelector('button[aria-label="Ask Polaris"]')
    fireEvent.click(button)
    expect(onChatClick).toHaveBeenCalledTimes(1)
  })
})

describe('TopBar theme menu', () => {
  test('the trigger keeps one accessible name whatever the theme is', () => {
    const { container, rerender } = render(
      <TopBar title="X" onMenuClick={vi.fn()} menuOpen={false} theme="system" resolvedTheme="dark" />
    )
    const button = container.querySelector('button[aria-label="Theme"]')
    expect(button).not.toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.getAttribute('aria-haspopup')).toBe('menu')

    rerender(<TopBar title="X" onMenuClick={vi.fn()} menuOpen={false} theme="light" resolvedTheme="light" />)
    expect(container.querySelector('button[aria-label="Theme"]')).not.toBeNull()
  })

  test('opens a menu of the three choices, with the current one checked', () => {
    const { container } = render(
      <TopBar title="X" onMenuClick={vi.fn()} menuOpen={false} theme="light" resolvedTheme="light" />
    )
    fireEvent.click(container.querySelector('button[aria-label="Theme"]'))

    expect(container.querySelector('button[aria-label="Theme"]').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu', { name: 'Theme' })).not.toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'System' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('menuitemradio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('false')
  })

  test('picking a choice reports it and closes the menu', () => {
    const onThemeChange = vi.fn()
    const { container } = render(
      <TopBar
        title="X"
        onMenuClick={vi.fn()}
        menuOpen={false}
        theme="system"
        resolvedTheme="dark"
        onThemeChange={onThemeChange}
      />
    )
    fireEvent.click(container.querySelector('button[aria-label="Theme"]'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Light' }))

    expect(onThemeChange).toHaveBeenCalledWith('light')
    expect(screen.queryByRole('menu', { name: 'Theme' })).toBeNull()
  })

  test('the menu items are 44px targets', () => {
    const { container } = render(
      <TopBar title="X" onMenuClick={vi.fn()} menuOpen={false} theme="system" resolvedTheme="dark" />
    )
    fireEvent.click(container.querySelector('button[aria-label="Theme"]'))
    for (const name of ['System', 'Light', 'Dark']) {
      expect(screen.getByRole('menuitemradio', { name }).style.minHeight).toBe('44px')
    }
  })
})

describe('TopBar refs', () => {
  test('menuButtonRef is attached to the menu button', () => {
    const menuButtonRef = createRef()
    render(<TopBar title="X" onMenuClick={vi.fn()} menuOpen={false} menuButtonRef={menuButtonRef} />)
    expect(menuButtonRef.current).not.toBeNull()
    expect(menuButtonRef.current.getAttribute('aria-label')).toBe('Open navigation')
  })

  test('chatButtonRef is attached to the chat button', () => {
    const chatButtonRef = createRef()
    render(
      <TopBar
        title="X"
        onMenuClick={vi.fn()}
        menuOpen={false}
        onChatClick={vi.fn()}
        chatOpen={false}
        chatButtonRef={chatButtonRef}
      />
    )
    expect(chatButtonRef.current).not.toBeNull()
    expect(chatButtonRef.current.getAttribute('aria-label')).toBe('Ask Polaris')
  })
})
