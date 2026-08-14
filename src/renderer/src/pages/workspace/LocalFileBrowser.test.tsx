// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LocalDirListing } from '../../../../shared/local-fs'
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

let container: HTMLElement
let root: Root
let listDir: ReturnType<typeof vi.fn>

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  listDir = vi.fn(async (path: string): Promise<LocalDirListing> => ({
    entries: [],
    truncated: false,
    resolvedPath: path
  }))
  ;(window as unknown as { api: unknown }).api = {
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
