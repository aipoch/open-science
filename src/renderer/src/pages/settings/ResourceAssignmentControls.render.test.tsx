// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSpecialistStore } from '@/stores/specialist-store'
import { ResourceAssignmentControls } from './ResourceAssignmentControls'

const profile = {
  kind: 'custom' as const,
  id: 'research',
  name: 'RESEARCH',
  description: '',
  systemPrompt: '',
  enabled: false,
  revision: 2,
  capabilityMode: 'selected' as const,
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: ['alpha'], connectorIds: [], connectorTools: [] }
}
const resource = {
  id: 'alpha',
  name: 'Alpha',
  kind: 'skill' as const,
  group: 'featured',
  mainEnabled: false
}
const update = vi.fn()

beforeEach(() => {
  useSpecialistStore.setState({
    items: [profile],
    isLoaded: true,
    integrity: { status: 'ok' },
    loadError: undefined
  })
  update.mockReset().mockImplementation(async (input) => ({ ...profile, ...input, revision: 3 }))
  window.api = {
    specialist: {
      list: vi.fn().mockResolvedValue({ items: [profile], integrity: { status: 'ok' } }),
      update
    }
  } as unknown as typeof window.api
})
afterEach(cleanup)

describe('resource assignment controls', () => {
  it('opens separate Main Agent and Specialist switches and changes only the requested profile', async () => {
    const setMain = vi.fn()
    render(<ResourceAssignmentControls resource={resource} onSetMain={setMain} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage access for Alpha' }))
    expect(screen.getAllByRole('switch')).toHaveLength(2)
    expect(screen.getByRole('switch', { name: 'Main Agent' }).getAttribute('aria-checked')).toBe(
      'false'
    )
    expect(screen.getByRole('switch', { name: 'RESEARCH' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    fireEvent.click(screen.getByRole('switch', { name: 'RESEARCH' }))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        id: 'research',
        revision: 2,
        selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] }
      })
    )
    expect(setMain).not.toHaveBeenCalled()
  })
  it('searches Specialists without hiding the required Main Agent or the search input', async () => {
    useSpecialistStore.setState({
      items: [
        profile,
        ...Array.from({ length: 5 }, (_, index) => ({
          ...profile,
          id: `other-${index}`,
          name: `OTHER_${index}`
        }))
      ]
    })
    render(
      <ResourceAssignmentControls
        resource={{ ...resource, mainEnabled: true, mainRequired: true }}
        onSetMain={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Manage access for Alpha' }))
    expect(screen.getByRole('switch', { name: 'Main Agent' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Specialists' }), {
      target: { value: 'research' }
    })
    expect(screen.getByRole('switch', { name: 'Main Agent' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('searchbox', { name: 'Search Specialists' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'RESEARCH' })).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Specialists' }), {
      target: { value: 'no-such-specialist' }
    })
    expect(screen.getByText('No Specialists match your search.')).toBeTruthy()
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    await act(async () => {})
  })
  it.each([0, 1, 5])('hides search for %i Specialists', (count) => {
    useSpecialistStore.setState({
      items: Array.from({ length: count }, (_, index) => ({ ...profile, id: `profile-${index}` }))
    })
    render(<ResourceAssignmentControls resource={resource} onSetMain={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage access for Alpha' }))
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getAllByRole('switch')).toHaveLength(count + 1)
  })
  it.each(['custom', 'builtin'] as const)(
    'opens %s Specialist details without changing assignments',
    (kind) => {
      useSpecialistStore.setState({
        items: [
          kind === 'builtin' ? { ...profile, kind, readonly: true, version: '1.0.0' } : profile
        ]
      })
      const navigate = vi.fn()
      render(
        <ResourceAssignmentControls
          resource={resource}
          onSetMain={vi.fn()}
          onOpenSpecialist={navigate}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Manage access for Alpha' }))
      fireEvent.click(screen.getByRole('button', { name: 'Open RESEARCH in Specialist Settings' }))
      expect(navigate).toHaveBeenCalledWith({ id: 'research', name: 'RESEARCH', kind })
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(update).not.toHaveBeenCalled()
    }
  )
  it('can retry a failed catalog read without changing any assignment', async () => {
    useSpecialistStore.setState({ loadError: 'temporary read failure' })
    render(<ResourceAssignmentControls resource={resource} onSetMain={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage access for Alpha' }))
    expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'RESEARCH' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'RESEARCH' }).disabled).toBe(
        false
      )
    )
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: 'RESEARCH' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
  })
  it('keeps the prior state and reports a rejected update', async () => {
    update.mockRejectedValue(new Error('revision conflict'))
    render(<ResourceAssignmentControls resource={resource} onSetMain={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage access for Alpha' }))
    fireEvent.click(screen.getByRole('switch', { name: 'RESEARCH' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('switch', { name: 'RESEARCH' }).getAttribute('aria-checked')).toBe(
      'true'
    )
  })
  it('preserves a save failure when the popover is dismissed during the request', async () => {
    let reject!: (error: Error) => void
    const request = new Promise<void>((_, fail) => {
      reject = fail
    })
    render(<ResourceAssignmentControls resource={resource} onSetMain={() => request} />)
    fireEvent.click(screen.getByRole('button', { name: 'Manage access for Alpha' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Main Agent' }))
    fireEvent.keyDown(screen.getByRole('switch', { name: 'Main Agent' }), { key: 'Escape' })
    await act(async () => {
      reject(new Error('write rejected'))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Manage access for Alpha' }))
    expect(screen.getByRole('alert').textContent).toContain('Could not update resource access')
  })
})
