import { describe, test, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Settings } from 'lucide-react'
import NavDrawer from './NavDrawer'

vi.mock('./command-center/ConnectionContext', () => ({
  useConnection: () => ({ connected: true, api: null }),
}))

afterEach(() => {
  cleanup()
})

describe('NavDrawer in the Android app', () => {
  test('pads its bottom by the navigation bar, so Settings is not drawn under it', () => {
    render(
      <NavDrawer
        open
        onClose={vi.fn()}
        primaryItems={[]}
        moreItems={[]}
        connectionItem={{ id: 'settings', label: 'Settings', icon: Settings }}
        activeTab="mytasks"
        onSelect={vi.fn()}
      />
    )
    const drawer = screen.getByRole('dialog', { name: 'Navigation' })
    expect(drawer.style.paddingTop).toBe('var(--safe-top)')
    expect(drawer.style.paddingBottom).toBe('var(--safe-bottom)')
  })
})
