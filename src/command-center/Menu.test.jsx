import { describe, test, expect, vi, afterEach } from 'vitest'
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Menu, Popover } from './Menu'

afterEach(() => cleanup())

// A minimal host: an anchor button plus the Menu, with its own open state so a
// selection (which calls onClose) is visible as the menu actually disappearing.
function Harness({ items, initialOpen = true, label = 'Test menu' }) {
  const [open, setOpen] = useState(initialOpen)
  const btnRef = useRef(null)
  return (
    <div>
      <button ref={btnRef} type="button" onClick={() => setOpen((v) => !v)}>
        Open menu
      </button>
      <Menu anchorRef={btnRef} open={open} onClose={() => setOpen(false)} items={items} label={label} />
    </div>
  )
}

function items3(onSelect = () => {}) {
  return [
    { key: 'a', label: 'Alpha', onSelect },
    { key: 'b', label: 'Bravo', onSelect },
    { key: 'c', label: 'Charlie', onSelect },
  ]
}

describe('Menu', () => {
  test('renders nothing while closed', () => {
    render(<Harness items={items3()} initialOpen={false} />)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('opening the menu focuses its first item', async () => {
    render(<Harness items={items3()} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' })))
  })

  test('Escape closes the menu and returns focus to the button that opened it', async () => {
    render(<Harness items={items3()} />)
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open menu' }))
  })

  test('a click outside the menu closes it', async () => {
    render(<Harness items={items3()} />)
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('a checked item is a menuitemcheckbox with aria-checked set', async () => {
    render(<Harness items={[{ key: 'x', label: 'Show archived', checked: true }]} />)
    const item = await screen.findByRole('menuitemcheckbox', { name: 'Show archived' })
    expect(item.getAttribute('aria-checked')).toBe('true')
  })

  test('a radio item is a menuitemradio, unchecked when another option is picked', async () => {
    render(<Harness items={[{ key: 'y', label: 'Priority', checked: false, radio: true }]} />)
    const item = await screen.findByRole('menuitemradio', { name: 'Priority' })
    expect(item.getAttribute('aria-checked')).toBe('false')
  })

  test('onSelect fires and the menu closes, since keepOpen was not set', async () => {
    const onSelect = vi.fn()
    render(<Harness items={[{ key: 'a', label: 'Alpha', onSelect }]} />)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Alpha' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('keepOpen keeps the menu open after a selection', async () => {
    const onSelect = vi.fn()
    render(<Harness items={[{ key: 'a', label: 'Show column', onSelect, keepOpen: true }]} />)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show column' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  test('a disabled item does not call onSelect', async () => {
    const onSelect = vi.fn()
    render(<Harness items={[{ key: 'a', label: 'Alpha', onSelect, disabled: true }]} />)
    const item = await screen.findByRole('menuitem', { name: 'Alpha' })
    expect(item.disabled).toBe(true)
    fireEvent.click(item)
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('ArrowDown/ArrowUp move focus between items and wrap at the ends', async () => {
    render(<Harness items={items3()} />)
    const alpha = await screen.findByRole('menuitem', { name: 'Alpha' })
    await waitFor(() => expect(document.activeElement).toBe(alpha))

    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Bravo' }))

    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(alpha)

    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Charlie' }))
  })

  test('Home and End jump to the first and last item', async () => {
    render(<Harness items={items3()} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' })))

    fireEvent.keyDown(document.activeElement, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Charlie' }))

    fireEvent.keyDown(document.activeElement, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Alpha' }))
  })

  test('a separator and a header render without being interactive items', async () => {
    render(
      <Harness
        items={[
          { key: 'h', type: 'header', label: 'Section' },
          { key: 's', type: 'separator' },
          { key: 'a', label: 'Alpha', onSelect: () => {} },
        ]}
      />
    )
    await screen.findByRole('menuitem', { name: 'Alpha' })
    expect(screen.getByText('Section')).toBeTruthy()
    expect(screen.getByRole('separator')).toBeTruthy()
  })
})

// preferFit (DueDateMenu.jsx): a popover too tall for the room under its trigger opens above it
// when there is more room there; without it, only less than 160px below flips it.
describe('Popover preferFit', () => {
  function Host({ preferFit }) {
    const ref = useRef(null)
    return (
      <>
        <button ref={ref} type="button">Anchor</button>
        <Popover anchorRef={ref} open onClose={() => {}} preferFit={preferFit}>
          <div role="dialog" aria-label="Tall">Tall content</div>
        </Popover>
      </>
    )
  }

  // A 768px window with the trigger's bottom at 500 (268px below, 480 above) and a 400px tall popover.
  function layout() {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 480, bottom: 500, left: 10, right: 110, width: 100, height: 20 })
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400)
    return () => { rect.mockRestore(); height.mockRestore() }
  }

  test('opens above when the content fits only there', async () => {
    const restore = layout()
    try {
      render(<Host preferFit />)
      const pop = (await screen.findByRole('dialog', { name: 'Tall' })).closest('[data-popover]')
      await waitFor(() => expect(pop.style.bottom).not.toBe(''))
      expect(pop.style.top).toBe('')
    } finally {
      restore()
    }
  })

  test('stays below without it', async () => {
    const restore = layout()
    try {
      render(<Host preferFit={false} />)
      const pop = (await screen.findByRole('dialog', { name: 'Tall' })).closest('[data-popover]')
      await new Promise((resolve) => requestAnimationFrame(() => resolve()))
      expect(pop.style.top).toBe('504px')
      expect(pop.style.bottom).toBe('')
    } finally {
      restore()
    }
  })
})
