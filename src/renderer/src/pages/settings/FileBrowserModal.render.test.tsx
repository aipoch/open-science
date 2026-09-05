// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, getByRole, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { openRadixMenu, clickRadixMenuItem } from './test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../../../shared/compute'
import type { DirListing, LocalFile } from '../../../../shared/remote-fs'
import { FileBrowserModal } from './FileBrowserModal'
import { i18next } from '@/i18n'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root

const deferred = <T,>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

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

// These assertions read the English catalog, so pin the language before rendering: another suite
// in the same worker may have left a different one active (changeLanguage settles on a promise).
const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
}

beforeEach(() => {
  switchTo('en')
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
  document.body.innerHTML = ''
  switchTo('en')
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

  it('calls onClose once when Escape is pressed', async () => {
    const onClose = vi.fn()

    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={onClose} initialProviderId="ssh:biowulf" />
      )
    })

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('navigates to initialPath on open instead of scratchRoot', async () => {
    const listDir = vi.fn().mockResolvedValue({ ...mockListing, resolvedPath: '/jobs/job-42' })
    setComputeApi({
      listDir,
      bookmarksGet: vi.fn().mockResolvedValue([]),
      bookmarksSet: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => {
      root.render(
        <FileBrowserModal
          open={true}
          onClose={vi.fn()}
          initialProviderId="ssh:biowulf"
          initialPath="/jobs/job-42"
        />
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    // listDir should have been called with the initialPath, not with /scratch/user (scratchRoot)
    expect(listDir).toHaveBeenCalledWith('ssh:biowulf', '/jobs/job-42')
    expect(listDir).not.toHaveBeenCalledWith('ssh:biowulf', '/scratch/user')
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

  it('offers credential recovery for the affected Host without a password modal', async () => {
    const openSettingsToComputeAuthentication = vi.fn()
    useSettingsStore.setState({ openSettingsToComputeAuthentication })
    setComputeApi({
      listDir: vi.fn().mockRejectedValue({
        message: 'Authentication failed. Verify the username and password.',
        remoteFsError: {
          detail: 'Authentication failed. Verify the username and password.',
          remoteKind: 'connection',
          authenticationCode: 'authentication_failed'
        }
      }),
      bookmarksGet: vi.fn().mockResolvedValue([]),
      bookmarksSet: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={vi.fn()} initialProviderId="ssh:biowulf" />
      )
      await Promise.resolve()
    })
    const manage = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Manage credentials'
    )
    await act(async () => manage?.click())

    expect(openSettingsToComputeAuthentication).toHaveBeenCalledWith(
      'ssh:biowulf',
      'authentication_failed'
    )
    expect(document.querySelector('input[type="password"]')).toBeNull()
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
    const fileButton = Array.from(document.querySelectorAll('button')).find((el) =>
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
    const fileButton = Array.from(document.querySelectorAll('button')).find((el) =>
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

  it('allows switching to an unprobed host and lets listDir determine reachability', async () => {
    const listDir = vi.fn().mockResolvedValue(mockListing)
    useComputeStore.setState({
      ...createInitialComputeState(),
      isLoaded: true,
      loadHosts: vi.fn(),
      hosts: [
        connectedHost({
          id: 'host-a',
          providerId: 'ssh:host-a',
          displayName: 'host-a',
          sshAlias: 'host-a'
        }),
        connectedHost({
          id: 'host-b',
          providerId: 'ssh:host-b',
          displayName: 'host-b',
          sshAlias: 'host-b',
          probeResult: undefined
        })
      ]
    })
    setComputeApi({
      listDir,
      bookmarksGet: vi.fn().mockResolvedValue([]),
      bookmarksSet: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => {
      root.render(<FileBrowserModal open={true} onClose={vi.fn()} initialProviderId="ssh:host-a" />)
      await Promise.resolve()
    })

    const hostBButton = Array.from(document.querySelectorAll('button')).find((element) =>
      element.textContent?.startsWith('host-b')
    ) as HTMLButtonElement | undefined
    expect(hostBButton?.disabled).toBe(false)

    await act(async () => {
      hostBButton?.click()
      await Promise.resolve()
    })

    expect(listDir).toHaveBeenCalledWith('ssh:host-b', '/scratch/user')
  })

  it('keeps the active host listing when the previous host responds last', async () => {
    const hostAListing = deferred<DirListing>()
    const hostBListing = deferred<DirListing>()
    const download = vi.fn().mockResolvedValue({
      path: '/Users/user/Downloads/from-host-b.txt',
      name: 'from-host-b.txt',
      size: 2,
      mimeType: 'text/plain'
    } as LocalFile)
    const listDir = vi.fn((providerId: string) =>
      providerId === 'ssh:host-a' ? hostAListing.promise : hostBListing.promise
    )
    useComputeStore.setState({
      ...createInitialComputeState(),
      isLoaded: true,
      loadHosts: vi.fn(),
      hosts: [
        connectedHost({
          id: 'host-a',
          providerId: 'ssh:host-a',
          displayName: 'host-a',
          sshAlias: 'host-a',
          scratchRoot: '/scratch/a'
        }),
        connectedHost({
          id: 'host-b',
          providerId: 'ssh:host-b',
          displayName: 'host-b',
          sshAlias: 'host-b',
          scratchRoot: '/scratch/b'
        })
      ]
    })
    setComputeApi({
      listDir,
      bookmarksGet: vi.fn().mockResolvedValue([]),
      bookmarksSet: vi.fn().mockResolvedValue(undefined),
      download,
      revealInFolder: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={vi.fn()} initialProviderId={'ssh:host-a'} />
      )
    })

    const hostBButton = Array.from(document.querySelectorAll('button')).find((element) =>
      element.textContent?.startsWith('host-b')
    ) as HTMLButtonElement | undefined
    await act(async () => {
      hostBButton?.click()
    })

    await act(async () => {
      hostBListing.resolve({
        entries: [{ name: 'from-host-b.txt', isDirectory: false, size: 2, mtimeMs: 1704067200000 }],
        truncated: false,
        roots: { home: '/home/b', scratch: '/scratch/b' },
        resolvedPath: '/scratch/b'
      })
      await hostBListing.promise
    })
    expect(document.body.textContent).toContain('from-host-b.txt')

    await act(async () => {
      hostAListing.resolve({
        entries: [{ name: 'from-host-a.txt', isDirectory: false, size: 1, mtimeMs: 1704067200000 }],
        truncated: false,
        roots: { home: '/home/a', scratch: '/scratch/a' },
        resolvedPath: '/scratch/a'
      })
      await hostAListing.promise
    })

    expect(document.body.textContent).toContain('from-host-b.txt')
    expect(document.body.textContent).not.toContain('from-host-a.txt')

    const fileButton = Array.from(document.querySelectorAll('button')).find((element) =>
      element.textContent?.includes('from-host-b.txt')
    ) as HTMLButtonElement | undefined
    await act(async () => {
      fileButton?.click()
    })
    const downloadButton = Array.from(document.querySelectorAll('button')).find((element) =>
      element.getAttribute('aria-label')?.includes('OS Downloads')
    ) as HTMLButtonElement | undefined
    await act(async () => {
      downloadButton?.click()
      await Promise.resolve()
    })

    expect(download).toHaveBeenCalledWith('ssh:host-b', '/scratch/b/from-host-b.txt', {
      kind: 'os-downloads'
    })
  })

  it('keeps the active host bookmarks when the previous host responds last', async () => {
    const hostABookmarks = deferred<string[]>()
    const hostBBookmarks = deferred<string[]>()
    const bookmarksGet = vi.fn((providerId: string) =>
      providerId === 'ssh:host-a' ? hostABookmarks.promise : hostBBookmarks.promise
    )
    useComputeStore.setState({
      ...createInitialComputeState(),
      isLoaded: true,
      loadHosts: vi.fn(),
      hosts: [
        connectedHost({
          id: 'host-a',
          providerId: 'ssh:host-a',
          displayName: 'host-a',
          sshAlias: 'host-a',
          scratchRoot: '/scratch/a'
        }),
        connectedHost({
          id: 'host-b',
          providerId: 'ssh:host-b',
          displayName: 'host-b',
          sshAlias: 'host-b',
          scratchRoot: '/scratch/b'
        })
      ]
    })
    setComputeApi({
      listDir: vi.fn((providerId: string) =>
        Promise.resolve({
          ...mockListing,
          resolvedPath: providerId === 'ssh:host-a' ? '/scratch/a' : '/scratch/b'
        })
      ),
      bookmarksGet,
      bookmarksSet: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={vi.fn()} initialProviderId={'ssh:host-a'} />
      )
      await Promise.resolve()
    })
    const hostBButton = Array.from(document.querySelectorAll('button')).find((element) =>
      element.textContent?.startsWith('host-b')
    ) as HTMLButtonElement | undefined
    await act(async () => {
      hostBButton?.click()
      await Promise.resolve()
    })

    await act(async () => {
      hostBBookmarks.resolve(['/scratch/b/pinned'])
      await hostBBookmarks.promise
    })
    await act(async () => {
      hostABookmarks.resolve(['/scratch/a/pinned'])
      await hostABookmarks.promise
    })

    const goToButton = document.querySelector('[aria-haspopup=menu]') as
      HTMLButtonElement | undefined
    await act(async () => {
      openRadixMenu(goToButton)
    })

    expect(document.body.textContent).toContain('/scratch/b/pinned')
    expect(document.body.textContent).not.toContain('/scratch/a/pinned')
  })

  it('exposes valid accessibility semantics while Go-to locations are open', async () => {
    await act(async () => {
      root.render(<FileBrowserModal open onClose={vi.fn()} initialProviderId="ssh:biowulf" />)
    })
    const trigger = screen.getByRole('button', { name: 'Go to' })
    await act(async () => openRadixMenu(trigger))
    expect(screen.getByText('Pin current folder')).toBeDefined()
    const result = await axe.run(document.body, {
      runOnly: { type: 'rule', values: ['aria-required-attr', 'aria-required-children'] }
    })
    expect(
      result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) }))
    ).toEqual([])
  })

  it('keeps bookmark diagnostics collapsed after load fails', async () => {
    setComputeApi({
      listDir: vi.fn().mockResolvedValue(mockListing),
      bookmarksGet: vi.fn().mockRejectedValue(new Error('Bookmark service unavailable')),
      bookmarksSet: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={vi.fn()} initialProviderId={'ssh:biowulf'} />
      )
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain("Couldn't load bookmarks.")
    const details = Array.from(document.querySelectorAll('details')).find((element) =>
      element.textContent?.includes('Bookmark service unavailable')
    )
    expect(details).toBeDefined()
    expect(details?.open).toBe(false)
  })

  it('restores bookmarks and shows an inline error when saving fails', async () => {
    setComputeApi({
      listDir: vi.fn().mockResolvedValue(mockListing),
      bookmarksGet: vi.fn().mockResolvedValue([]),
      bookmarksSet: vi.fn().mockRejectedValue(new Error('Bookmark write failed'))
    })

    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={vi.fn()} initialProviderId={'ssh:biowulf'} />
      )
      await Promise.resolve()
    })
    const goToButton = document.querySelector('[aria-haspopup=menu]') as
      HTMLButtonElement | undefined
    await act(async () => {
      openRadixMenu(goToButton)
    })
    const pinButton = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (element) => element.textContent?.includes('Pin current folder')
    ) as HTMLButtonElement | undefined
    await act(async () => {
      clickRadixMenuItem(pinButton)
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain("Couldn't update bookmarks.")
    expect(document.body.textContent).toContain('Bookmark write failed')
  })

  it('removes a bookmark and persists the updated list', async () => {
    const bookmarksSet = vi.fn().mockResolvedValue(undefined)
    setComputeApi({
      listDir: vi.fn().mockResolvedValue(mockListing),
      bookmarksGet: vi.fn().mockResolvedValue(['/scratch/user/pinned']),
      bookmarksSet
    })

    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={vi.fn()} initialProviderId={'ssh:biowulf'} />
      )
      await Promise.resolve()
    })
    const goToButton = document.querySelector('[aria-haspopup=menu]') as
      HTMLButtonElement | undefined
    await act(async () => {
      openRadixMenu(goToButton)
    })
    const removeButton = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find(
      (element) => element.getAttribute('aria-label') === 'Remove bookmark /scratch/user/pinned'
    ) as HTMLButtonElement | undefined
    await act(async () => {
      clickRadixMenuItem(removeButton)
      await Promise.resolve()
    })

    expect(bookmarksSet).toHaveBeenCalledWith('ssh:biowulf', [])
    expect(document.body.textContent).not.toContain('/scratch/user/pinned')
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
    const fileButton = Array.from(document.querySelectorAll('button')).find((el) =>
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

  it('does not offer the last workspace Project after returning home', async () => {
    useProjectStore.setState({
      projects: [{ id: 'proj-1', name: 'My Project', createdAt: 1, updatedAt: 1 }],
      isLoaded: true,
      loadError: undefined
    } as Parameters<typeof useProjectStore.setState>[0])
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'proj-1' })
    useNavigationStore.getState().goHome('user')

    await act(async () => {
      root.render(
        <FileBrowserModal open={true} onClose={vi.fn()} initialProviderId="ssh:biowulf" />
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    const fileButton = Array.from(document.querySelectorAll('button')).find((element) =>
      element.textContent?.includes('readme.txt')
    ) as HTMLElement | undefined
    expect(fileButton).toBeDefined()
    await act(async () => {
      fileButton?.click()
    })

    expect(document.body.textContent).not.toContain('Add to project')
  })
})

describe('FileBrowserModal accessibility regressions', () => {
  const renderBrowser = async (onClose = vi.fn()): Promise<void> => {
    await act(async () => {
      root.render(<FileBrowserModal open onClose={onClose} initialProviderId="ssh:biowulf" />)
    })
  }

  const openGoTo = async (): Promise<HTMLElement> => {
    const trigger = getByRole(document.body, 'button', { name: 'Go to' })
    await act(async () => {
      trigger.focus()
      fireEvent.keyDown(trigger, { key: 'Enter' })
      // Native buttons synthesize click for Enter in a browser; jsdom does not.
      if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    return trigger
  }

  it('regression: Escape dismisses Go to before the file browser', async () => {
    const onClose = vi.fn()
    await renderBrowser(onClose)
    const trigger = await openGoTo()
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('regression: Go to supports keyboard focus and ArrowDown navigation', async () => {
    await renderBrowser()
    await openGoTo()
    expect(document.activeElement?.textContent).toContain('Scratch')
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    })
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Home'))
  })

  it('regression: Go to and directory children match their ARIA container roles', async () => {
    await renderBrowser()
    await openGoTo()
    const result = await axe.run(document.body, {
      runOnly: {
        type: 'rule',
        values: ['aria-required-children', 'aria-required-parent', 'nested-interactive']
      }
    })
    expect(
      result.violations.map(({ id, nodes }) => ({ id, html: nodes.map((node) => node.html) }))
    ).toEqual([])
  })

  it('regression: host buttons expose the current selection', async () => {
    await renderBrowser()
    expect(
      getByRole(document.body, 'button', { name: /biowulf/ }).getAttribute('aria-pressed')
    ).toBe('true')
  })

  it.each([
    { probeResult: connectedHost().probeResult, status: 'Probe succeeded' },
    { probeResult: { ...connectedHost().probeResult!, ok: false }, status: 'Probe failed' },
    { probeResult: undefined, status: 'Not probed yet' }
  ])(
    'regression: host buttons expose probe status as text ($status)',
    async ({ probeResult, status }) => {
      useComputeStore.setState({ hosts: [connectedHost({ probeResult })] })
      await renderBrowser()
      const host = getByRole(document.body, 'button', { name: new RegExp(`biowulf.*${status}`) })
      expect(host.getAttribute('aria-pressed')).toBe('true')
    }
  )
})

it('regression: a remote directory can be opened using native button activation', async () => {
  await act(async () => {
    root.render(<FileBrowserModal open onClose={vi.fn()} initialProviderId="ssh:biowulf" />)
  })
  const entry = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.startsWith('data')
  )!
  expect(entry).toBeDefined()
  await act(async () => {
    entry.focus()
    // Enter on a native button produces a click, not a double-click.
    entry.click()
  })
  expect(window.api.compute.listDir).toHaveBeenLastCalledWith('ssh:biowulf', '/scratch/user/data')
})

it('regression: clicking outside Go to dismisses only its popup', async () => {
  const onClose = vi.fn()
  await act(async () => {
    root.render(<FileBrowserModal open onClose={onClose} initialProviderId="ssh:biowulf" />)
  })
  const trigger = getByRole(document.body, 'button', { name: 'Go to' })
  await act(async () => {
    fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0, ctrlKey: false })
    fireEvent.click(trigger)
  })
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  const address = getByRole(document.body, 'textbox', { name: 'Current directory path' })
  await act(async () => {
    fireEvent.pointerDown(address, { pointerType: 'mouse', button: 0 })
    fireEvent.click(address)
  })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(onClose).not.toHaveBeenCalled()
})
