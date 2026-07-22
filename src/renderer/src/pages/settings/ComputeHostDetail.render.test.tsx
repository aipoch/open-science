// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../../../shared/compute'
import { ComputeHostDetail } from './ComputeHostDetail'
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

// Stub window.api.compute.detailsGet so the component does not hit real IPC.
const stubDetailsGet = (doc: string, isSkeleton = false): void => {
  ;(globalThis as unknown as { window: { api: { compute: Record<string, unknown> } } }).window = {
    api: {
      compute: {
        detailsGet: vi.fn().mockResolvedValue({ doc, isSkeleton })
      }
    }
  } as never
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  const state = {
    ...createInitialComputeState(),
    isLoaded: true,
    loadHosts: vi.fn(),
    probeHost: vi.fn(),
    deleteHost: vi.fn(),
    saveDetails: vi.fn(),
    setScratch: vi.fn(),
    setConcurrency: vi.fn()
  }
  useComputeStore.setState(state)
  stubDetailsGet('')
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('ComputeHostDetail', () => {
  it('shows loading state when host list is not loaded', () => {
    useComputeStore.setState({ isLoaded: false })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" onRemoved={vi.fn()} />)
    })

    expect(container.textContent).toContain('Loading host')
  })

  it('shows "no longer exists" when host is not in the store', () => {
    useComputeStore.setState({ hosts: [], isLoaded: true })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" onRemoved={vi.fn()} />)
    })

    expect(container.textContent).toContain('no longer exists')
  })

  it('renders host name and provider id', () => {
    useComputeStore.setState({ hosts: [host()], isLoaded: true })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" onRemoved={vi.fn()} />)
    })

    expect(container.textContent).toContain('biowulf')
    expect(container.textContent).toContain('ssh:biowulf')
  })

  it('shows Details, Scratch root, and Concurrent job limit sections', () => {
    useComputeStore.setState({ hosts: [host()], isLoaded: true })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" onRemoved={vi.fn()} />)
    })

    expect(container.textContent).toContain('Details')
    expect(container.textContent).toContain('Scratch root')
    expect(container.textContent).toContain('Concurrent job limit')
  })

  it('shows PINNED badge when scratchPinned is true', () => {
    useComputeStore.setState({
      hosts: [host({ scratchRoot: '/my/scratch', scratchPinned: true })],
      isLoaded: true
    })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" onRemoved={vi.fn()} />)
    })

    expect(container.textContent).toContain('PINNED')
  })

  it('shows (default) when concurrencyLimit is not set', () => {
    useComputeStore.setState({ hosts: [host()], isLoaded: true })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" onRemoved={vi.fn()} />)
    })

    expect(container.textContent).toContain('(default)')
  })

  it('shows concurrencyLimit value when set', () => {
    useComputeStore.setState({ hosts: [host({ concurrencyLimit: 10 })], isLoaded: true })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" onRemoved={vi.fn()} />)
    })

    expect(container.textContent).toContain('10')
  })

  it('calls saveDetails with author=user when Save is clicked in details editor', async () => {
    const saveDetails = vi.fn(() => Promise.resolve())
    useComputeStore.setState({ hosts: [host()], isLoaded: true, saveDetails })
    stubDetailsGet('original notes')

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" onRemoved={vi.fn()} />)
    })

    // Wait for the detailsGet effect to resolve.
    await act(async () => {
      await Promise.resolve()
    })

    const editButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Edit' && b.closest('div')?.textContent?.includes('Details')
    )
    act(() => {
      editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const textarea = container.querySelector('textarea')
    expect(textarea).toBeTruthy()

    act(() => {
      Object.defineProperty(textarea!, 'value', { value: 'updated notes', writable: true })
      textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save'
    )
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // saveDetails should have been called with 'user' as author.
    expect(saveDetails).toHaveBeenCalled()
  })
})
