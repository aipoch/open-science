// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GrantedLocalRoot, LocalDirListing } from '../../../../shared/local-fs'
import {
  createInitialGrantedFoldersState,
  useGrantedFoldersStore
} from '@/stores/granted-folders-store'
import { GrantFolderAccessDialog } from './GrantFolderAccessDialog'

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

  it('shows the out-of-scope error after a breadcrumb jump outside home and skips listDir', async () => {
    renderDialog()
    await flush()

    await click(document.body.querySelector('[data-testid="grant-access-crumb-Users"]'))

    expect(document.body.textContent).toContain('Directory is not under $HOME or a granted root.')
    expect(listDir).not.toHaveBeenCalledWith('/Users')
    expect(listDir).not.toHaveBeenCalledWith('/Users/roxi/Projects')
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

  it('segments a Windows drive path into drive-root and folder crumbs', async () => {
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
        listDir: winListDir,
        listGrantedRoots: vi.fn().mockResolvedValue([]),
        grantRoot
      }
    }
    renderDialog()
    await flush()

    // The drive root leads the breadcrumb, followed by the folder segments.
    expect(crumb('C:\\')).toBeDefined()
    expect(crumb('Users')).toBeDefined()

    // Navigating into a subfolder joins with the Windows separator.
    await click(document.body.querySelector('[data-testid="grant-access-folder-Projects"]'))
    expect(winListDir).toHaveBeenCalledWith('C:\\Users\\roxi\\Projects')

    // Jumping to the drive root is out of scope and never lists.
    await click(crumb('C:\\'))
    expect(document.body.textContent).toContain('Directory is not under $HOME or a granted root.')
    expect(winListDir).not.toHaveBeenCalledWith('C:\\')
  })
})
