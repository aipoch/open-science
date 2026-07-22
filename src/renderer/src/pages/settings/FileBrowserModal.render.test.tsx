// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../../../shared/compute'
import type { DirListing, LocalFile } from '../../../../shared/remote-fs'
import { FileBrowserModal } from './FileBrowserModal'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'

let container: HTMLDivElement
let root: Root

const connectedHost = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: '/scratch/user',
  scratchPinned: true,
  concurrencyLimit: undefined,
  probeResult: {
    ok: true,
    probedAt: new Date().toISOString(),
    exitCode: 0,
    errorTail: null,
    cpus: 4
  },
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const mockListing: DirListing = {
  entries: [
    { name: 'data', isDirectory: true, size: 0, mtimeMs: 1704067200000 },
    { name: 'readme.txt', isDirectory: false, size: 1024, mtimeMs: 1704067200000 }
  ],
  truncated: false,
  roots: { home: '/home/user', scratch: '/scratch/user' },
  resolvedPath: '/scratch/user'
}

const setComputeApi = (api: Partial<Window['api']['compute']>): void => {
  // Preserve the real window (including getComputedStyle etc) while injecting api.
  // We use Object.defineProperty to add api to the existing global window — replacing
  // globalThis.window wholesale breaks window.getComputedStyle, which radix-ui's portal needs.
  Object.defineProperty(globalThis.window, 'api', {
    configurable: true,
    writable: true,
    value: { compute: api }
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useComputeStore.setState({
    ...createInitialComputeState(),
    isLoaded: true,
    loadHosts: vi.fn(),
    hosts: [connectedHost()]
  })
  setComputeApi({
    listDir: vi.fn().mockResolvedValue(mockListing),
    bookmarksGet: vi.fn().mockResolvedValue([]),
    bookmarksSet: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue({
      path: '/Users/user/Downloads/readme.txt',
      name: 'readme.txt',
      size: 1024,
      mimeType: 'text/plain'
    } as LocalFile),
    revealInFolder: vi.fn().mockResolvedValue(undefined)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('FileBrowserModal', () => {
  it('renders nothing when open=false', () => {
    act(() => {
      root.render(<FileBrowserModal open={false} onClose={vi.fn()} />)
    })
    expect(container.querySelector('[aria-label="Remote file browser"]')).toBeNull()
  })

  it('renders the modal when open=true and shows host chip', async () => {
    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={vi.fn()} initialProviderId="ssh:biowulf" />
      )
    })
    // Modal content is rendered in a portal; check document.body
    expect(document.body.textContent).toContain('biowulf')
  })

  it('shows directory listing after load', async () => {
    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={vi.fn()} initialProviderId="ssh:biowulf" />
      )
    })
    // Wait for the async listDir to resolve
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('data')
    expect(document.body.textContent).toContain('readme.txt')
  })

  it('shows error banner when listDir fails', async () => {
    setComputeApi({
      listDir: vi.fn().mockRejectedValue({
        message: 'Connection refused',
        remoteFsError: { detail: 'Connection refused', remoteKind: 'connection' }
      }),
      bookmarksGet: vi.fn().mockResolvedValue([]),
      bookmarksSet: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={vi.fn()} initialProviderId="ssh:biowulf" />
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain("Couldn't open this path.")
  })

  it('shows detail panel when a file is selected', async () => {
    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={vi.fn()} initialProviderId="ssh:biowulf" />
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Click on readme.txt to select it
    const fileButton = Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
      el.textContent?.includes('readme.txt')
    ) as HTMLElement | undefined
    await act(async () => {
      fileButton?.click()
    })

    expect(document.body.textContent).toContain('SIZE')
    expect(document.body.textContent).toContain('No preview')
    expect(document.body.textContent).toContain('Copy path')
    // Download button should be visible
    expect(document.body.textContent).toContain('Download')
  })

  it('shows Download button in detail panel and calls download IPC on click', async () => {
    const downloadMock = vi.fn().mockResolvedValue({
      path: '/Users/user/Downloads/readme.txt',
      name: 'readme.txt',
      size: 1024,
      mimeType: 'text/plain'
    } as LocalFile)
    setComputeApi({
      listDir: vi.fn().mockResolvedValue(mockListing),
      bookmarksGet: vi.fn().mockResolvedValue([]),
      bookmarksSet: vi.fn().mockResolvedValue(undefined),
      download: downloadMock,
      revealInFolder: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={vi.fn()} initialProviderId="ssh:biowulf" />
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Select readme.txt
    const fileButton = Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
      el.textContent?.includes('readme.txt')
    ) as HTMLElement | undefined
    await act(async () => {
      fileButton?.click()
    })

    // Click the Download button
    const downloadButton = Array.from(document.querySelectorAll('button')).find(
      (el) =>
        el.textContent?.includes('Download') &&
        el.getAttribute('aria-label')?.includes('OS Downloads')
    ) as HTMLElement | undefined
    await act(async () => {
      downloadButton?.click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(downloadMock).toHaveBeenCalledWith('ssh:biowulf', '/scratch/user/readme.txt', {
      kind: 'os-downloads'
    })
    // Should show success message
    expect(document.body.textContent).toContain('Saved to Downloads')
  })

  it('shows Add to project button when a project is active', async () => {
    // Set an active project
    useProjectStore.setState({
      projects: [{ id: 'proj-1', name: 'My Project', createdAt: 1, updatedAt: 1 }],
      isLoaded: true,
      loadError: undefined
    } as Parameters<typeof useProjectStore.setState>[0])
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'proj-1' })

    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={vi.fn()} initialProviderId="ssh:biowulf" />
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Select readme.txt
    const fileButton = Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
      el.textContent?.includes('readme.txt')
    ) as HTMLElement | undefined
    await act(async () => {
      fileButton?.click()
    })

    // Add to project button is visible but disabled — artifact persistence isn't wired yet
    // (issue 06), so the entry point is greyed out rather than showing a misleading success.
    expect(document.body.textContent).toContain('Add to project')
    const addButton = Array.from(document.querySelectorAll('button')).find((el) =>
      el.textContent?.includes('Add to project')
    ) as HTMLButtonElement | undefined
    expect(addButton?.disabled).toBe(true)
  })
})
