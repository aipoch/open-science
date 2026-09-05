// @vitest-environment jsdom
import { act } from 'react'
import axe from 'axe-core'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LocalDirListing, LocalRoots } from '../../../../shared/local-fs'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { LocalFileBrowser } from './LocalFileBrowser'

// Radix DropdownMenu calls pointer-capture APIs that jsdom does not implement. Replace with a
// flat render so the Go-to menu's content is always visible and items fire onSelect on click.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  DropdownMenuContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div>{children}</div>
  ),
  DropdownMenuLabel: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    ...rest
  }: PropsWithChildren<{ onSelect?: () => void }>): React.JSX.Element => (
    <button type="button" onClick={onSelect} {...rest}>
      {children}
    </button>
  )
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOME = '/Users/roxi'
const GRANTED = `${HOME}/data`
const OTHER_GRANTED = `${HOME}/results`

let container: HTMLElement
let root: Root
let listDir: ReturnType<typeof vi.fn>

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(() => {
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  listDir = vi.fn(async (path: string): Promise<LocalDirListing> => ({
    entries: [],
    truncated: false,
    resolvedPath: path
  }))
  ;(window as unknown as { api: unknown }).api = {
    platform: 'darwin',
    localFs: {
      getRoots: vi.fn().mockResolvedValue({ home: HOME, machineName: 'Test Mac' }),
      listDrives: vi.fn().mockResolvedValue([
        { path: '/', label: '/' },
        { path: '/Volumes/External', label: 'External' }
      ]),
      listDir
    },
    compute: {
      bookmarksGet: vi.fn().mockResolvedValue([]),
      bookmarksSet: vi.fn().mockResolvedValue(undefined)
    }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const addressInput = (): HTMLInputElement | null =>
  document.body.querySelector<HTMLInputElement>('[aria-label="Directory path"]')

const zIndexFromClassName = (element: Element): number => {
  const match = element.className.match(/(?:^|\s)z-\[(\d+)\](?:\s|$)/)
  return match ? Number(match[1]) : 0
}

describe('LocalFileBrowser requestedPath', () => {
  it('lands in Home without a requested path', async () => {
    await act(async () => {
      root.render(<LocalFileBrowser />)
    })
    await flush()

    expect(listDir).toHaveBeenCalledWith(HOME)
    expect(addressInput()?.value).toBe(HOME)
  })

  it('navigates when the requested path nonce changes', async () => {
    await act(async () => {
      root.render(<LocalFileBrowser />)
    })
    await flush()
    expect(addressInput()?.value).toBe(HOME)

    await act(async () => {
      root.render(<LocalFileBrowser requestedPath={{ path: GRANTED, nonce: 1 }} />)
    })
    await flush()

    expect(listDir).toHaveBeenCalledWith(GRANTED)
    expect(addressInput()?.value).toBe(GRANTED)
  })

  it('does not re-navigate for a nonce it already handled', async () => {
    await act(async () => {
      root.render(<LocalFileBrowser requestedPath={{ path: GRANTED, nonce: 1 }} />)
    })
    await flush()
    expect(listDir).toHaveBeenCalledTimes(1)

    // Re-render with the same request: no additional listing call.
    await act(async () => {
      root.render(<LocalFileBrowser requestedPath={{ path: GRANTED, nonce: 1 }} />)
    })
    await flush()
    expect(listDir).toHaveBeenCalledTimes(1)
  })

  it('uses a request pending at mount as the initial location instead of Home', async () => {
    await act(async () => {
      root.render(<LocalFileBrowser requestedPath={{ path: GRANTED, nonce: 1 }} />)
    })
    await flush()

    expect(listDir).toHaveBeenCalledTimes(1)
    expect(listDir).toHaveBeenCalledWith(GRANTED)
    expect(listDir).not.toHaveBeenCalledWith(HOME)
    expect(addressInput()?.value).toBe(GRANTED)
  })

  it('does not let the bootstrap Home navigation replace a request received while roots load', async () => {
    const roots = deferred<LocalRoots>()
    window.api.localFs.getRoots = vi.fn().mockReturnValue(roots.promise)

    act(() => root.render(<LocalFileBrowser />))
    await flush()
    act(() => root.render(<LocalFileBrowser requestedPath={{ path: GRANTED, nonce: 1 }} />))
    await flush()
    expect(addressInput()?.value).toBe(GRANTED)

    await act(async () => {
      roots.resolve({ home: HOME, machineName: 'Test Mac' })
      await roots.promise
    })
    await flush()

    expect(listDir).not.toHaveBeenCalledWith(HOME)
    expect(addressInput()?.value).toBe(GRANTED)
  })

  it('does not let an older navigation response replace the latest requested path', async () => {
    await act(async () => {
      root.render(<LocalFileBrowser />)
    })
    await flush()

    const older = deferred<LocalDirListing>()
    const latest = deferred<LocalDirListing>()
    listDir.mockImplementation((path: string) => {
      if (path === GRANTED) return older.promise
      if (path === OTHER_GRANTED) return latest.promise
      return Promise.resolve({ entries: [], truncated: false, resolvedPath: path })
    })

    act(() => root.render(<LocalFileBrowser requestedPath={{ path: GRANTED, nonce: 1 }} />))
    act(() => root.render(<LocalFileBrowser requestedPath={{ path: OTHER_GRANTED, nonce: 2 }} />))

    await act(async () => {
      latest.resolve({ entries: [], truncated: false, resolvedPath: OTHER_GRANTED })
      await latest.promise
    })
    expect(addressInput()?.value).toBe(OTHER_GRANTED)

    await act(async () => {
      older.resolve({ entries: [], truncated: false, resolvedPath: GRANTED })
      await older.promise
    })

    expect(addressInput()?.value).toBe(OTHER_GRANTED)
  })
})

describe('LocalFileBrowser sensitive paths', () => {
  const renderEntries = async (entries: LocalDirListing['entries']): Promise<void> => {
    listDir.mockImplementation(async (path: string): Promise<LocalDirListing> => ({
      entries: path === HOME ? entries : [],
      truncated: false,
      resolvedPath: path
    }))
    await act(async () => {
      root.render(<LocalFileBrowser />)
    })
    await flush()
  }

  const clickEntry = async (name: string): Promise<void> => {
    const entryButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(name)
    )
    expect(entryButton).toBeDefined()
    await act(async () => {
      entryButton?.click()
    })
  }

  it('keeps sensitive-folder consent in the app and cancels without navigating', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await renderEntries([{ name: '.ssh', isDirectory: true, size: 0, mtimeMs: 0 }])

    await clickEntry('.ssh')

    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Open sensitive folder?')
    expect(dialog?.textContent).toContain('may contain credentials or secrets')
    expect(dialog?.textContent).toContain(`${HOME}/.ssh`)
    expect(confirm).not.toHaveBeenCalled()

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="sensitive-local-path-cancel"]')
        ?.click()
    })

    expect(listDir).not.toHaveBeenCalledWith(`${HOME}/.ssh`)
  })

  it('navigates to a sensitive folder only after confirmation', async () => {
    await renderEntries([{ name: '.ssh', isDirectory: true, size: 0, mtimeMs: 0 }])
    await clickEntry('.ssh')

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="sensitive-local-path-confirm"]')
        ?.click()
      await Promise.resolve()
    })

    expect(listDir).toHaveBeenCalledWith(`${HOME}/.ssh`)
  })

  it('opens a sensitive file preview only after naming it in the confirmation', async () => {
    await renderEntries([{ name: 'id_ed25519', isDirectory: false, size: 128, mtimeMs: 1 }])
    await clickEntry('id_ed25519')

    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Open sensitive file?')
    expect(dialog?.textContent).toContain(`${HOME}/id_ed25519`)
    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(0)

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="sensitive-local-path-confirm"]')
        ?.click()
    })

    expect(usePreviewWorkbenchStore.getState().items).toEqual([
      expect.objectContaining({
        name: 'id_ed25519',
        path: `${HOME}/id_ed25519`,
        source: 'local'
      })
    ])
  })

  it('stacks sensitive-path consent above an expanded Files preview', async () => {
    listDir.mockImplementation(async (path: string): Promise<LocalDirListing> => ({
      entries: path === HOME ? [{ name: '.ssh', isDirectory: true, size: 0, mtimeMs: 0 }] : [],
      truncated: false,
      resolvedPath: path
    }))
    await act(async () => {
      root.render(
        <section role="dialog" data-testid="expanded-files-preview" className="z-[56]">
          <LocalFileBrowser />
        </section>
      )
    })
    await flush()

    await clickEntry('.ssh')

    const expandedPreview = container.querySelector('[data-testid="expanded-files-preview"]')
    const overlay = document.body.querySelector('[data-testid="sensitive-local-path-overlay"]')
    const dialog = document.body.querySelector('[data-testid="sensitive-local-path-dialog"]')
    expect(expandedPreview).not.toBeNull()
    expect(overlay).not.toBeNull()
    expect(dialog).not.toBeNull()
    expect(zIndexFromClassName(overlay!)).toBeGreaterThan(zIndexFromClassName(expandedPreview!))
    expect(zIndexFromClassName(dialog!)).toBeGreaterThan(zIndexFromClassName(expandedPreview!))
  })
})

describe('LocalFileBrowser Go to menu', () => {
  // Finds the menu button whose text contains the given label.
  const menuButton = (label: string): HTMLElement | undefined =>
    Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes(label))
  const menuLabel = (text: string): HTMLElement | undefined =>
    Array.from(document.body.querySelectorAll('div')).find((d) => d.textContent === text)
  // True when `later` comes after `earlier` in document order.
  const follows = (earlier: HTMLElement, later: HTMLElement): boolean =>
    Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)

  it('lists Home first and uncategorized, then the drives group; drives navigate on select', async () => {
    await act(async () => {
      root.render(<LocalFileBrowser />)
    })
    await flush()

    const homeItem = menuButton('Home') as HTMLElement
    const volumesLabel = menuLabel('Volumes') as HTMLElement
    const drive = document.body.querySelector(
      '[data-testid="go-to-drive-/Volumes/External"]'
    ) as HTMLElement
    expect(homeItem).not.toBeNull()
    expect(volumesLabel).not.toBeNull()
    expect(drive).not.toBeNull()
    // Home precedes the Volumes group and sits above its label — no category of its own.
    expect(follows(homeItem, volumesLabel)).toBe(true)
    expect(follows(volumesLabel, drive)).toBe(true)
    // Drive rows show the full volume name (wrap, no clipping); other rows keep truncate + title.
    const driveLabel = Array.from(drive.querySelectorAll('span')).find(
      (el) => el.textContent === 'External'
    )
    expect(driveLabel?.className).toContain('break-words')
    expect(driveLabel?.className).not.toContain('truncate')
    const homeLabel = Array.from(homeItem.querySelectorAll('span')).find(
      (el) => el.textContent === 'Home'
    )
    expect(homeLabel?.className).toContain('truncate')
    expect(homeLabel?.getAttribute('title')).toBe('Home')

    await act(async () => {
      drive.click()
      await Promise.resolve()
    })

    expect(listDir).toHaveBeenCalledWith('/Volumes/External')
    expect(addressInput()?.value).toBe('/Volumes/External')
  })

  it('closes the Pinned group with the pin action, after every bookmark', async () => {
    ;(window.api.compute.bookmarksGet as ReturnType<typeof vi.fn>).mockResolvedValue([
      `${HOME}/.cache`
    ])
    await act(async () => {
      root.render(<LocalFileBrowser />)
    })
    await flush()

    const pinnedLabel = menuLabel('Pinned') as HTMLElement
    const bookmarkItem = menuButton('.cache') as HTMLElement
    const pinAction = menuButton('Pin current folder') as HTMLElement
    expect(pinnedLabel).not.toBeNull()
    expect(bookmarkItem).not.toBeNull()
    expect(pinAction).not.toBeNull()
    expect(follows(pinnedLabel, bookmarkItem)).toBe(true)
    expect(follows(bookmarkItem, pinAction)).toBe(true)
  })
})

it('regression: local directory children match their ARIA container role', async () => {
  listDir.mockImplementation(async (path: string): Promise<LocalDirListing> => ({
    entries: [{ name: 'data', isDirectory: true, size: 0, mtimeMs: 1704067200000 }],
    truncated: false,
    resolvedPath: path
  }))
  await act(async () => {
    root.render(<LocalFileBrowser />)
  })
  await flush()
  const result = await axe.run(container, {
    runOnly: { type: 'rule', values: ['aria-required-children', 'aria-required-parent'] }
  })
  expect(
    result.violations.map(({ id, nodes }) => ({ id, html: nodes.map((node) => node.html) }))
  ).toEqual([])
})
