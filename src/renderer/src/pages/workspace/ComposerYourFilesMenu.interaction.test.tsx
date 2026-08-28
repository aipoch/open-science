// @vitest-environment jsdom
import { act, cloneElement, isValidElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren, ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GrantedLocalRoot, LocalDirEntry, LocalDirListing } from '../../../../shared/local-fs'
import {
  createInitialGrantedFoldersState,
  useGrantedFoldersStore
} from '@/stores/granted-folders-store'

import { ComposerYourFilesMenu } from './ComposerYourFilesMenu'

// React's act() refuses to run unless the environment opts in to act-aware scheduling.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Captured so tests can fire the submenu's open/close transitions (the flat mock never calls it).
const subState = vi.hoisted(() => ({
  onOpenChange: undefined as ((open: boolean) => void) | undefined
}))

// Radix DropdownMenu calls pointer-capture APIs that jsdom does not implement.
// Replace with a flat render so the submenu content is always visible in the DOM.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  DropdownMenuContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div>{children}</div>
  ),
  DropdownMenuSub: ({
    children,
    onOpenChange
  }: PropsWithChildren<{ onOpenChange?: (open: boolean) => void }>): React.JSX.Element => {
    subState.onOpenChange = onOpenChange
    return <div>{children}</div>
  },
  DropdownMenuSubTrigger: ({
    children,
    ...rest
  }: PropsWithChildren<{ 'data-testid'?: string }>): React.JSX.Element => (
    <div {...rest}>{children}</div>
  ),
  DropdownMenuSubContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    asChild,
    children,
    disabled,
    onSelect,
    ...rest
  }: PropsWithChildren<{
    asChild?: boolean
    disabled?: boolean
    onSelect?: () => void
    'data-testid'?: string
  }>): React.JSX.Element =>
    // asChild items keep their real child element; wire the select handler onto its click.
    asChild && isValidElement(children) ? (
      cloneElement(children as ReactElement<{ onClick?: () => void }>, {
        ...rest,
        onClick: onSelect
      })
    ) : (
      <button type="button" disabled={disabled} onClick={onSelect} {...rest}>
        {children}
      </button>
    )
}))

const ROOT: GrantedLocalRoot = {
  id: 'root-1',
  path: '/Users/roxi/data',
  name: 'data',
  access: 'ro'
}

const entry = (name: string, isDirectory: boolean): LocalDirEntry => ({
  name,
  isDirectory,
  size: 0,
  mtimeMs: 0
})

// Absolute directory path → entries served by the mocked listDir.
const LISTINGS: Record<string, LocalDirEntry[]> = {
  [ROOT.path]: [entry('raw', true), entry('study.csv', false)],
  [`${ROOT.path}/raw`]: [entry('notes.md', false)]
}

let container: HTMLDivElement
let root: Root
let listDir: ReturnType<typeof vi.fn>
let removeGrantedRoot: ReturnType<typeof vi.fn>

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const click = async (element: Element | null | undefined): Promise<void> => {
  await act(async () => {
    ;(element as HTMLElement | null)?.click()
    await Promise.resolve()
  })
}

beforeEach(() => {
  useGrantedFoldersStore.setState({
    ...createInitialGrantedFoldersState(),
    roots: [ROOT],
    loaded: true
  })
  listDir = vi.fn(async (path: string): Promise<LocalDirListing> => ({
    entries: LISTINGS[path] ?? [],
    truncated: false,
    resolvedPath: path
  }))
  removeGrantedRoot = vi.fn().mockResolvedValue([])
  ;(window as unknown as { api: unknown }).api = {
    localFs: {
      listDir,
      getRoots: vi.fn().mockResolvedValue({ home: '/Users/roxi', machineName: 'Test Mac' }),
      listDrives: vi.fn(async () => []),
      listGrantedRoots: vi.fn().mockResolvedValue([ROOT]),
      grantRoot: vi.fn().mockResolvedValue([ROOT]),
      setGrantedRootAccess: vi.fn().mockResolvedValue([ROOT]),
      removeGrantedRoot
    }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  useGrantedFoldersStore.setState(createInitialGrantedFoldersState())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
  vi.restoreAllMocks()
})

const renderMenu = (onInsertFileReference = vi.fn()): ReturnType<typeof vi.fn> => {
  act(() => {
    root.render(<ComposerYourFilesMenu onInsertFileReference={onInsertFileReference} />)
  })
  return onInsertFileReference
}

describe('ComposerYourFilesMenu', () => {
  it('renders the trigger and granted roots with their access badges', () => {
    renderMenu()

    expect(container.querySelector('[data-testid="composer-your-files-trigger"]')).not.toBeNull()
    const rootRow = container.querySelector('[data-testid="your-files-root-root-1"]')
    expect(rootRow?.textContent).toContain('data')
    expect(rootRow?.textContent).toContain('ro')
  })

  it('keeps hidden row actions visible to keyboard and no-hover users', async () => {
    renderMenu()

    const removeButton = container.querySelector('[data-testid="your-files-remove-root-1"]')
    expect(removeButton?.classList).not.toContain('opacity-0')
    expect(removeButton?.classList).toContain('[@media(hover:hover)]:opacity-0')
    expect(removeButton?.classList).toContain('[@media(hover:hover)]:focus-visible:opacity-100')
    expect(removeButton?.classList).toContain('focus-visible:ring-[3px]')
    expect(removeButton?.classList).toContain('[@media(pointer:coarse)]:size-11')
    expect(removeButton?.parentElement?.classList).toContain('[@media(pointer:coarse)]:h-11')

    await click(container.querySelector('[data-testid="your-files-root-toggle-root-1"]'))
    await flush()

    const sendButton = container.querySelector('[data-testid="your-files-send-root-1-study.csv"]')
    expect(sendButton?.classList).not.toContain('opacity-0')
    expect(sendButton?.classList).toContain('[@media(hover:hover)]:opacity-0')
    expect(sendButton?.classList).toContain('[@media(hover:hover)]:focus-visible:opacity-100')
    expect(sendButton?.classList).toContain('focus-visible:ring-[3px]')
    expect(sendButton?.classList).toContain('[@media(pointer:coarse)]:size-11')
    expect(sendButton?.parentElement?.classList).toContain('[@media(pointer:coarse)]:min-h-11')
  })
  it('gives root and nested directory toggles coarse-pointer hit targets', async () => {
    renderMenu()

    const rootToggle = container.querySelector('[data-testid="your-files-root-toggle-root-1"]')
    expect(rootToggle?.classList).toContain('[@media(pointer:coarse)]:min-h-11')

    await click(rootToggle)
    await flush()

    const nestedToggle = container.querySelector('[data-testid="your-files-dir-root-1-raw"]')
    expect(nestedToggle?.classList).toContain('[@media(pointer:coarse)]:min-h-11')
    expect(nestedToggle?.parentElement?.classList).toContain('[@media(pointer:coarse)]:py-0')
  })

  it('shows a quiet hint when no folders are granted', () => {
    useGrantedFoldersStore.setState({ roots: [], loaded: true })
    renderMenu()

    expect(container.textContent).toContain('No folders granted yet.')
  })

  it('lazily lists a root on expand and drills into subdirectories', async () => {
    renderMenu()

    expect(listDir).not.toHaveBeenCalled()

    await click(container.querySelector('[data-testid="your-files-root-toggle-root-1"]'))
    await flush()

    expect(listDir).toHaveBeenCalledWith(ROOT.path)
    expect(container.querySelector('[data-testid="your-files-dir-root-1-raw"]')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="your-files-file-root-1-study.csv"]')
    ).not.toBeNull()

    await click(container.querySelector('[data-testid="your-files-dir-root-1-raw"]'))
    await flush()

    expect(listDir).toHaveBeenCalledWith(`${ROOT.path}/raw`)
    expect(
      container.querySelector('[data-testid="your-files-file-root-1-raw/notes.md"]')
    ).not.toBeNull()
  })

  it('does not insert when the file row body (not the send button) is clicked', async () => {
    const onInsertFileReference = renderMenu()

    await click(container.querySelector('[data-testid="your-files-root-toggle-root-1"]'))
    await flush()
    await click(container.querySelector('[data-testid="your-files-file-root-1-study.csv"]'))

    expect(onInsertFileReference).not.toHaveBeenCalled()
  })

  it('inserts a linked-folder reference with the root id and posix relative path on send', async () => {
    const onInsertFileReference = renderMenu()

    await click(container.querySelector('[data-testid="your-files-root-toggle-root-1"]'))
    await flush()
    await click(container.querySelector('[data-testid="your-files-send-root-1-study.csv"]'))

    expect(onInsertFileReference).toHaveBeenCalledTimes(1)
    expect(onInsertFileReference).toHaveBeenCalledWith({
      id: expect.any(String),
      name: 'study.csv',
      source: 'linked-folder',
      rootId: 'root-1',
      relativePath: 'study.csv',
      mimeType: undefined
    })
  })

  it('inserts the nested relative path for a file inside a subdirectory', async () => {
    const onInsertFileReference = renderMenu()

    await click(container.querySelector('[data-testid="your-files-root-toggle-root-1"]'))
    await flush()
    await click(container.querySelector('[data-testid="your-files-dir-root-1-raw"]'))
    await flush()
    await click(container.querySelector('[data-testid="your-files-send-root-1-raw/notes.md"]'))

    expect(onInsertFileReference).toHaveBeenCalledWith(
      expect.objectContaining({
        rootId: 'root-1',
        relativePath: 'raw/notes.md',
        source: 'linked-folder'
      })
    )
  })

  it('removes access via the store from the hover × action', async () => {
    renderMenu()

    const removeButton = container.querySelector('[data-testid="your-files-remove-root-1"]')
    expect(removeButton?.className).toContain('focus-visible:opacity-100')
    expect(removeButton?.className).toContain('[@media(hover:none)]:opacity-100')
    expect(removeButton?.className).toContain('motion-reduce:transition-none')
    await click(removeButton)
    await flush()

    expect(removeGrantedRoot).toHaveBeenCalledWith({ id: 'root-1' })
    expect(container.querySelector('[data-testid="your-files-root-root-1"]')).toBeNull()
  })

  it('keeps failed access removal visible and retryable', async () => {
    removeGrantedRoot
      .mockRejectedValueOnce(new Error('permission store unavailable'))
      .mockResolvedValueOnce([])
    renderMenu()

    await click(container.querySelector('[data-testid="your-files-remove-root-1"]'))
    await flush()

    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    const retry = [...(alert?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Retry'
    )
    expect(container.querySelector('[data-testid="your-files-root-root-1"]')).not.toBeNull()
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain('Could not remove folder access.')
    expect(retry).not.toBeUndefined()

    await click(retry)
    await flush()

    expect(container.querySelector('[data-testid="your-files-root-root-1"]')).toBeNull()
  })

  it('shows a quiet inline note when listing a directory fails', async () => {
    listDir.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    renderMenu()

    await click(container.querySelector('[data-testid="your-files-root-toggle-root-1"]'))
    await flush()

    expect(container.textContent).toContain("You don't have access to:")
  })

  it('opens the grant dialog from the Grant folder… action', async () => {
    renderMenu()

    await click(container.querySelector('[data-testid="your-files-grant-folder"]'))
    await flush()

    expect(document.body.querySelector('[data-testid="grant-folder-access-dialog"]')).not.toBeNull()
  })

  it('marks a sent file with a green check and ignores repeat clicks', async () => {
    const onInsertFileReference = renderMenu()

    await click(container.querySelector('[data-testid="your-files-root-toggle-root-1"]'))
    await flush()
    await click(container.querySelector('[data-testid="your-files-send-root-1-study.csv"]'))
    await flush()

    const sendButton = container.querySelector('[data-testid="your-files-send-root-1-study.csv"]')
    expect(sendButton?.getAttribute('aria-label')).toBe('study.csv added to conversation')

    await click(sendButton)

    expect(onInsertFileReference).toHaveBeenCalledTimes(1)
  })

  it('clears the added check marks when the submenu closes', async () => {
    renderMenu()

    await click(container.querySelector('[data-testid="your-files-root-toggle-root-1"]'))
    await flush()
    await click(container.querySelector('[data-testid="your-files-send-root-1-study.csv"]'))
    await flush()

    expect(
      container
        .querySelector('[data-testid="your-files-send-root-1-study.csv"]')
        ?.getAttribute('aria-label')
    ).toContain('added to conversation')

    act(() => subState.onOpenChange?.(false))

    expect(
      container
        .querySelector('[data-testid="your-files-send-root-1-study.csv"]')
        ?.getAttribute('aria-label')
    ).toBe('Add study.csv to conversation as attachment')
  })
})
