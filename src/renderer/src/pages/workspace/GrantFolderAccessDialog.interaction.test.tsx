// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GrantedLocalRoot, LocalDirListing } from '../../../../shared/local-fs'
import {
  createInitialGrantedFoldersState,
  useGrantedFoldersStore
} from '@/stores/granted-folders-store'
import { GrantFolderAccessDialog } from './GrantFolderAccessDialog'

// Radix DropdownMenu calls pointer-capture APIs that jsdom does not implement. Replace with a
// flat render so the drive menu's content is always visible in the DOM and items fire onSelect
// on click.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren): React.JSX.Element => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: PropsWithChildren): React.JSX.Element => <>{children}</>,
  DropdownMenuContent: ({ children }: PropsWithChildren): React.JSX.Element => (
    <div>{children}</div>
  ),
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

// Path → subfolder names served by the mocked listDir.
const SUBFOLDERS: Record<string, string[]> = {
  [HOME]: ['Projects', 'Library'],
  [`${HOME}/Projects`]: []
}

const grantedRoot: GrantedLocalRoot = {
  id: 'root-1',
  path: `${HOME}/Projects`,
  name: 'Projects',
  access: 'ro'
}

const DRIVES = [
  { path: '/', label: '/' },
  { path: '/Volumes/External', label: 'External' }
]

let container: HTMLElement
let root: Root
let listDir: ReturnType<typeof vi.fn>
let grantRoot: ReturnType<typeof vi.fn>

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  useGrantedFoldersStore.setState(createInitialGrantedFoldersState())
  listDir = vi.fn(async (path: string): Promise<LocalDirListing> => ({
    entries: (SUBFOLDERS[path] ?? []).map((name) => ({
      name,
      isDirectory: true,
      size: 0,
      mtimeMs: 0
    })),
    truncated: false,
    resolvedPath: path
  }))
  grantRoot = vi.fn().mockResolvedValue([grantedRoot])
  ;(window as unknown as { api: unknown }).api = {
    localFs: {
      getRoots: vi.fn().mockResolvedValue({ home: HOME, machineName: 'Test Mac' }),
      listDrives: vi.fn().mockResolvedValue(DRIVES),
      listDir,
      listGrantedRoots: vi.fn().mockResolvedValue([]),
      grantRoot
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

const renderDialog = (onGranted?: (root: GrantedLocalRoot) => void): void => {
  act(() => {
    root.render(
      <GrantFolderAccessDialog open onOpenChange={() => undefined} onGranted={onGranted} />
    )
  })
}

const click = async (element: Element | null | undefined): Promise<void> => {
  await act(async () => {
    ;(element as HTMLElement | null)?.click()
    await Promise.resolve()
  })
}

// Finds a crumb by exact label; CSS selectors can't express the Windows "C:\" label's backslash.
const crumb = (label: string): Element | undefined =>
  Array.from(document.body.querySelectorAll('[data-testid^="grant-access-crumb-"]')).find(
    (element) => element.getAttribute('data-testid') === `grant-access-crumb-${label}`
  )

// Same for drive-menu entries, whose testids carry raw paths ("C:\", "/Volumes/External").
const driveEntry = (path: string): Element | undefined =>
  Array.from(document.body.querySelectorAll('[data-testid^="grant-access-drive-"]')).find(
    (element) => element.getAttribute('data-testid') === `grant-access-drive-${path}`
  )

describe('GrantFolderAccessDialog', () => {
  it('lists the home subfolders on open', async () => {
    renderDialog()
    await flush()

    expect(document.body.textContent).toContain('Grant folder access')
    expect(document.body.textContent).toContain('Projects')
    expect(document.body.textContent).toContain('Library')
    expect(listDir).toHaveBeenCalledWith(HOME)
  })

  it('navigates into a subfolder and back via the breadcrumb', async () => {
    renderDialog()
    await flush()

    await click(document.body.querySelector('[data-testid="grant-access-folder-Projects"]'))
    expect(listDir).toHaveBeenCalledWith(`${HOME}/Projects`)
    expect(document.body.textContent).toContain('No subfolders.')

    await click(document.body.querySelector('[data-testid="grant-access-crumb-home"]'))
    expect(document.body.textContent).toContain('Projects')
    expect(document.body.textContent).toContain('Library')
  })

  it('lists folders outside home after a breadcrumb jump (cross-drive browsing)', async () => {
    renderDialog()
    await flush()

    await click(document.body.querySelector('[data-testid="grant-access-crumb-Users"]'))

    expect(listDir).toHaveBeenCalledWith('/Users')
    expect(document.body.textContent).toContain('No subfolders.')
    expect(document.body.textContent).not.toContain('out of scope')
  })

  it('swaps the breadcrumb for a path input on bar click and navigates on submit', async () => {
    renderDialog()
    await flush()

    // Clicking the bar's own empty area (target === currentTarget) opens the editor.
    await click(document.body.querySelector('[data-testid="grant-access-path-bar"]'))
    const input = document.body.querySelector<HTMLInputElement>('[aria-label="Folder path"]')
    expect(input).not.toBeNull()
    expect(input?.value).toBe(HOME)
    expect(input?.selectionStart).toBe(0)
    expect(input?.selectionEnd).toBe(HOME.length)

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set
      setter?.call(input, `${HOME}/Projects`)
      input?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })

    expect(listDir).toHaveBeenCalledWith(`${HOME}/Projects`)
    // The bar is back to breadcrumb rendering.
    expect(document.body.querySelector('[aria-label="Folder path"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="grant-access-path-bar"]')).not.toBeNull()
  })

  it('cancels path editing on Escape without navigating', async () => {
    renderDialog()
    await flush()
    const initialCalls = listDir.mock.calls.length

    await click(document.body.querySelector('[data-testid="grant-access-path-bar"]'))
    const input = document.body.querySelector<HTMLInputElement>('[aria-label="Folder path"]')
    expect(input).not.toBeNull()

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })

    expect(document.body.querySelector('[aria-label="Folder path"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="grant-access-path-bar"]')).not.toBeNull()
    expect(listDir.mock.calls.length).toBe(initialCalls)
  })

  it('lists the drives in the root crumb menu and navigates on select', async () => {
    renderDialog()
    await flush()

    // The root crumb shows the current volume; the menu lists every mounted drive/volume.
    expect(
      document.body.querySelector('[data-testid="grant-access-drive-root"]')?.textContent
    ).toContain('/')
    const rootItem = document.body.querySelector('[data-testid="grant-access-drive-/"]')
    const externalItem = document.body.querySelector(
      '[data-testid="grant-access-drive-/Volumes/External"]'
    )
    expect(rootItem).not.toBeNull()
    expect(externalItem).not.toBeNull()
    // Home sits on /, so that entry is the highlighted current drive.
    expect(rootItem?.getAttribute('aria-current')).toBe('true')
    expect(externalItem?.getAttribute('aria-current')).toBeNull()

    await click(externalItem)
    expect(listDir).toHaveBeenCalledWith('/Volumes/External')
    // The root crumb now tracks the external volume.
    expect(
      document.body.querySelector('[data-testid="grant-access-drive-root"]')?.textContent
    ).toContain('External')
  })

  it('shows the home hint and disables Grant while cwd is home', async () => {
    renderDialog()
    await flush()

    expect(document.body.textContent).toContain(
      "Your home folder itself can't be granted — pick a subfolder."
    )
    const grantButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="grant-access-grant"]'
    )
    expect(grantButton?.disabled).toBe(true)
  })

  it('shows "Directory could not be accessed." when the grant is rejected', async () => {
    grantRoot.mockRejectedValue(new Error('Directory is outside the granted scope.'))
    renderDialog()
    await flush()

    await click(document.body.querySelector('[data-testid="grant-access-folder-Projects"]'))
    await click(document.body.querySelector('[data-testid="grant-access-grant"]'))

    expect(document.body.textContent).toContain('Directory could not be accessed.')
    // The failure clears on navigation.
    await click(document.body.querySelector('[data-testid="grant-access-crumb-home"]'))
    expect(document.body.textContent).not.toContain('Directory could not be accessed.')
  })

  it('grants the current folder, closes, and reports the new root', async () => {
    const onGranted = vi.fn()
    const onOpenChange = vi.fn()
    act(() => {
      root.render(
        <GrantFolderAccessDialog open onOpenChange={onOpenChange} onGranted={onGranted} />
      )
    })
    await flush()

    await click(document.body.querySelector('[data-testid="grant-access-folder-Projects"]'))
    // Switch to read & write before granting.
    await click(document.body.querySelector('[role="radio"][aria-checked="false"]'))
    await click(document.body.querySelector('[data-testid="grant-access-grant"]'))

    expect(grantRoot).toHaveBeenCalledWith({ path: `${HOME}/Projects`, access: 'rw' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onGranted).toHaveBeenCalledWith(grantedRoot)
    expect(useGrantedFoldersStore.getState().roots).toEqual([grantedRoot])
  })

  it('segments a Windows drive path and switches drives via the root crumb menu', async () => {
    const WIN_HOME = 'C:\\Users\\roxi'
    const winListDir = vi.fn(async (path: string): Promise<LocalDirListing> => ({
      entries:
        path === WIN_HOME ? [{ name: 'Projects', isDirectory: true, size: 0, mtimeMs: 0 }] : [],
      truncated: false,
      resolvedPath: path
    }))
    ;(window as unknown as { api: unknown }).api = {
      platform: 'win32',
      localFs: {
        getRoots: vi.fn().mockResolvedValue({ home: WIN_HOME, machineName: 'Test PC' }),
        listDrives: vi.fn().mockResolvedValue([
          { path: 'C:\\', label: 'C:' },
          { path: 'D:\\', label: 'D:' }
        ]),
        listDir: winListDir,
        listGrantedRoots: vi.fn().mockResolvedValue([]),
        grantRoot
      }
    }
    renderDialog()
    await flush()

    // The drive root leads the bar as the dropdown trigger, followed by the folder segments.
    expect(
      document.body.querySelector('[data-testid="grant-access-drive-root"]')?.textContent
    ).toContain('C:')
    expect(crumb('Users')).toBeDefined()

    // Navigating into a subfolder joins with the Windows separator.
    await click(document.body.querySelector('[data-testid="grant-access-folder-Projects"]'))
    expect(winListDir).toHaveBeenCalledWith('C:\\Users\\roxi\\Projects')

    // Selecting another drive from the menu navigates to its root.
    await click(driveEntry('D:\\'))
    expect(winListDir).toHaveBeenCalledWith('D:\\')
  })
})
