import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AgentSettings from './AgentSettings'
import { markOffline, resetOfflineStatus } from './offlineStatus'
import { useDefaultAgentName, resetDefaultAgentNameCache } from './defaultAgentName'

const api = {
  getAgentSettings: vi.fn(),
  updateAgentSettings: vi.fn(),
}
const connection = { connected: true, api }
vi.mock('./ConnectionContext', () => ({ useConnection: () => connection }))

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  resetDefaultAgentNameCache()
  connection.connected = true
})

afterEach(() => {
  cleanup()
  resetOfflineStatus()
})

describe('AgentSettings', () => {
  test('shows nothing when not connected', () => {
    connection.connected = false
    const { container } = render(<AgentSettings />)
    expect(container.textContent).toBe('')
    expect(api.getAgentSettings).not.toHaveBeenCalled()
  })

  test('renders the current default agent name in a labelled text box', async () => {
    api.getAgentSettings.mockResolvedValue({ defaultAgentName: 'claude-code' })
    render(<AgentSettings />)
    const card = await screen.findByRole('region', { name: 'Agents' })
    const input = screen.getByLabelText('Default agent name')
    expect(card.contains(input)).toBe(true)
    expect(input.value).toBe('claude-code')
  })

  test('text typed before the first load finishes is kept when it lands', async () => {
    let resolve
    api.getAgentSettings.mockReturnValue(new Promise((r) => { resolve = r }))
    render(<AgentSettings />)

    const input = screen.getByLabelText('Default agent name')
    fireEvent.change(input, { target: { value: 'new-agent' } })
    await act(async () => { resolve({ defaultAgentName: 'scribe' }) })

    expect(screen.getByLabelText('Default agent name').value).toBe('new-agent')
  })

  test('a name saved before the first load finishes is not undone by that load', async () => {
    let resolve
    api.getAgentSettings.mockReturnValue(new Promise((r) => { resolve = r }))
    api.updateAgentSettings.mockResolvedValue({ defaultAgentName: 'new-agent' })
    render(<AgentSettings />)

    const input = screen.getByLabelText('Default agent name')
    fireEvent.change(input, { target: { value: 'new-agent' } })
    fireEvent.blur(input)
    await waitFor(() => expect(screen.getByLabelText('Default agent name').value).toBe('new-agent'))
    await act(async () => { resolve({ defaultAgentName: 'scribe' }) })

    expect(screen.getByLabelText('Default agent name').value).toBe('new-agent')
  })

  test('saves the new name on blur', async () => {
    api.getAgentSettings.mockResolvedValue({ defaultAgentName: 'claude-code' })
    api.updateAgentSettings.mockResolvedValue({ defaultAgentName: 'scribe' })
    render(<AgentSettings />)

    const input = await screen.findByLabelText('Default agent name')
    fireEvent.change(input, { target: { value: 'scribe' } })
    fireEvent.blur(input)

    await waitFor(() => expect(api.updateAgentSettings).toHaveBeenCalledWith({ defaultAgentName: 'scribe' }))
    await waitFor(() => expect(screen.getByLabelText('Default agent name').value).toBe('scribe'))
  })

  test('a saved name is visible to an open task panel through useDefaultAgentName', async () => {
    api.getAgentSettings.mockResolvedValue({ defaultAgentName: 'claude-code' })
    api.updateAgentSettings.mockResolvedValue({ defaultAgentName: 'scribe' })
    function Panel() {
      return <output aria-label="Panel name">{useDefaultAgentName(api) ?? ''}</output>
    }
    render(<><Panel /><AgentSettings /></>)
    await waitFor(() => expect(screen.getByLabelText('Panel name').textContent).toBe('claude-code'))

    const input = await screen.findByLabelText('Default agent name')
    fireEvent.change(input, { target: { value: 'scribe' } })
    fireEvent.blur(input)

    await waitFor(() => expect(screen.getByLabelText('Panel name').textContent).toBe('scribe'))
  })

  test('Enter saves like blur', async () => {
    api.getAgentSettings.mockResolvedValue({ defaultAgentName: 'claude-code' })
    api.updateAgentSettings.mockResolvedValue({ defaultAgentName: 'scribe' })
    render(<AgentSettings />)

    const input = await screen.findByLabelText('Default agent name')
    input.focus()
    fireEvent.change(input, { target: { value: 'scribe' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(api.updateAgentSettings).toHaveBeenCalledWith({ defaultAgentName: 'scribe' }))
  })

  test('a name that did not change sends nothing on blur', async () => {
    api.getAgentSettings.mockResolvedValue({ defaultAgentName: 'claude-code' })
    render(<AgentSettings />)

    const input = await screen.findByLabelText('Default agent name')
    fireEvent.blur(input)

    expect(api.updateAgentSettings).not.toHaveBeenCalled()
  })

  test('Esc discards what was typed, without saving it', async () => {
    api.getAgentSettings.mockResolvedValue({ defaultAgentName: 'claude-code' })
    render(<AgentSettings />)

    const input = await screen.findByLabelText('Default agent name')
    input.focus()
    fireEvent.change(input, { target: { value: 'something else' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(input.value).toBe('claude-code')
    expect(api.updateAgentSettings).not.toHaveBeenCalled()
  })

  test('a rejected save (the server\'s 400) shows an inline message and keeps the typed value', async () => {
    api.getAgentSettings.mockResolvedValue({ defaultAgentName: 'claude-code' })
    api.updateAgentSettings.mockRejectedValue(new Error('Use 1 to 40 letters, digits, spaces, -, _, or .'))
    render(<AgentSettings />)

    const input = await screen.findByLabelText('Default agent name')
    fireEvent.change(input, { target: { value: '###' } })
    fireEvent.blur(input)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('letters, digits')
    expect(screen.getByLabelText('Default agent name').value).toBe('###')
  })

  test('offline, the input is disabled', async () => {
    api.getAgentSettings.mockResolvedValue({ defaultAgentName: 'claude-code' })
    markOffline()
    render(<AgentSettings />)

    const input = await screen.findByLabelText('Default agent name')
    expect(input.disabled).toBe(true)
  })
})
