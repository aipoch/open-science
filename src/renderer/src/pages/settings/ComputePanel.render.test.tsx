// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../../../shared/compute'
import { ComputePanel } from './ComputePanel'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'

let container: HTMLDivElement
let root: Root

const host = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useComputeStore.setState({ ...createInitialComputeState(), isLoaded: true, loadHosts: vi.fn() })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('ComputePanel', () => {
  it('renders the header banner and empty state', () => {
    act(() => {
      root.render(<ComputePanel onNavigate={vi.fn()} />)
    })

    expect(container.textContent).toContain('Connect where heavy compute runs')
    expect(container.textContent).toContain('SSH hosts')
    expect(container.textContent).toContain('No SSH hosts yet')
  })

  it('renders a host card with its provider id string', () => {
    useComputeStore.setState({ hosts: [host()], isLoaded: true })

    act(() => {
      root.render(<ComputePanel onNavigate={vi.fn()} />)
    })

    expect(container.textContent).toContain('biowulf')
    expect(container.textContent).toContain('ssh:biowulf')
  })

  it('navigates to the add form when Add SSH host is clicked', () => {
    const onNavigate = vi.fn()

    act(() => {
      root.render(<ComputePanel onNavigate={onNavigate} />)
    })

    const addButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Add SSH host')
    )
    act(() => {
      addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'add' })
  })

  it('deletes a host and shows a confirmation toast', async () => {
    const deleteHost = vi.fn(() => Promise.resolve())
    useComputeStore.setState({ hosts: [host()], isLoaded: true, deleteHost })

    act(() => {
      root.render(<ComputePanel onNavigate={vi.fn()} />)
    })

    const removeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Remove biowulf'
    )
    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(deleteHost).toHaveBeenCalledWith('ssh:biowulf')
    expect(container.textContent).toContain('Removed biowulf.')
  })
})
