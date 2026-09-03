// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
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

const deferGrant = (): ((roots: GrantedLocalRoot[]) => void) => {
  let resolveGrant!: (roots: GrantedLocalRoot[]) => void
  grantRoot.mockReturnValue(
    new Promise<GrantedLocalRoot[]>((resolve) => {
      resolveGrant = resolve
    })
  )
  return resolveGrant
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

const confirmGrant = async (): Promise<void> => {
  const confirmation = document.body.querySelector(
    '[data-testid="grant-folder-access-confirmation"]'
  )
  await click(confirmation?.querySelector('button:last-of-type'))
}

const cancelGrant = async (): Promise<void> => {
  const confirmation = document.body.querySelector(
    '[data-testid="grant-folder-access-confirmation"]'
  )
  await click(confirmation?.querySelector('button:first-of-type'))
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

const pathInput = (): HTMLInputElement | null =>
  document.body.querySelector<HTMLInputElement>('[aria-label="Folder path"]')

// Types into the controlled path input the way React expects (native setter + input event).
const typeInto = async (input: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const keyOn = async (input: HTMLInputElement, key: string): Promise<void> => {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    await Promise.resolve()
  })
}

describe('GrantFolderAccessDialog', () => {
  it('uses the shared dialog header, close action, and divider treatment', async () => {
    const onOpenChange = vi.fn()
    act(() => {
      root.render(<GrantFolderAccessDialog open onOpenChange={onOpenChange} />)
    })
    await flush()

    const title = document.body.querySelector('[role="dialog"] h2')
    expect(title?.className).toContain('text-lg font-semibold text-text-000')
    expect(title?.parentElement?.className).toContain('border-b border-border-300/90 px-5 py-3.5')

    const closeButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="grant-access-close"]'
    )
    expect(closeButton?.className).toContain('cursor-pointer')
    await click(closeButton)
    expect(onOpenChange).toHaveBeenCalledWith(false)

    const footer = document.body.querySelector('[data-testid="grant-access-footer"]')
    expect(footer?.className).toContain('border-t border-border-300/90 px-5 py-3.5')
  })

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
    const input = pathInput()
    expect(input).not.toBeNull()
    expect(input?.value).toBe(HOME)
    // Caret lands at the end of the prefilled path; no select-all.
    expect(input?.selectionStart).toBe(HOME.length)
    expect(input?.selectionEnd).toBe(HOME.length)

    await typeInto(input as HTMLInputElement, `${HOME}/Projects`)
    await keyOn(input as HTMLInputElement, 'Enter')

    expect(listDir).toHaveBeenCalledWith(`${HOME}/Projects`)
    // The bar is back to breadcrumb rendering.
    expect(pathInput()).toBeNull()
    expect(document.body.querySelector('[data-testid="grant-access-path-bar"]')).not.toBeNull()
  })

  it('does not re-select the path text on each keystroke', async () => {
    renderDialog()
    await flush()

    await click(document.body.querySelector('[data-testid="grant-access-path-bar"]'))
    const input = pathInput() as HTMLInputElement
    // Mount: caret at the end of the prefilled path, nothing selected.
    expect(input.selectionStart).toBe(HOME.length)
    expect(input.selectionEnd).toBe(HOME.length)

    // A keystroke appends at the caret and leaves it after the new character, like a real browser.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set
      setter?.call(input, `${HOME}X`)
      input.setSelectionRange(HOME.length + 1, HOME.length + 1)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // The re-render must not move the caret or re-select (an inline ref callback re-ran on every
    // keystroke and reset the selection while typing).
    expect(input.value).toBe(`${HOME}X`)
    expect(input.selectionStart).toBe(HOME.length + 1)
    expect(input.selectionEnd).toBe(HOME.length + 1)
  })

  it('submits the path edit on blur and navigates', async () => {
    renderDialog()
    await flush()

    await click(document.body.querySelector('[data-testid="grant-access-path-bar"]'))
    const input = pathInput() as HTMLInputElement
    await typeInto(input, `${HOME}/Projects`)
    await act(async () => {
      // React wires onBlur to the bubbling focusout event.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await Promise.resolve()
    })

    expect(listDir).toHaveBeenCalledWith(`${HOME}/Projects`)
    expect(pathInput()).toBeNull()
  })

  it('opens the path editor when the tail crumb is clicked', async () => {
    renderDialog()
    await flush()

    await click(document.body.querySelector('[data-testid="grant-access-crumb-current"]'))

    const input = pathInput()
    expect(input).not.toBeNull()
    expect(input?.value).toBe(HOME)
  })

  it('surfaces a quiet error for an invalid path and clears it on a no-op submit', async () => {
    renderDialog()
    await flush()
    expect(document.body.textContent).toContain('Projects')

    await click(document.body.querySelector('[data-testid="grant-access-path-bar"]'))
    const input = pathInput() as HTMLInputElement
    // A control character is never valid in a path, even after resolving against cwd.
    await typeInto(input, '/bad\x01path')
    await keyOn(input, 'Enter')

    expect(document.body.textContent).toContain('That path contains invalid characters.')
    expect(document.body.textContent).not.toContain('Projects')

    await act(async () => i18next.changeLanguage('zh-Hans'))
    expect(document.body.textContent).toContain('该路径包含无效字符。')
    expect(document.body.textContent).not.toContain('That path contains invalid characters.')
    await act(async () => i18next.changeLanguage('en'))

    // Reopening the editor and submitting the unchanged cwd re-lists and clears the error.
    await click(document.body.querySelector('[data-testid="grant-access-path-bar"]'))
    await keyOn(pathInput() as HTMLInputElement, 'Enter')
    await flush()

    expect(document.body.textContent).not.toContain('That path contains invalid characters.')
    expect(document.body.textContent).toContain('Projects')
  })

  it('highlights the longest matching linux mount point instead of /', async () => {
    ;(window as unknown as { api: unknown }).api = {
      platform: 'linux',
      localFs: {
        getRoots: vi.fn().mockResolvedValue({ home: HOME, machineName: 'Test Box' }),
        listDrives: vi.fn().mockResolvedValue([
          { path: '/', label: '/' },
          { path: '/media/user/usb', label: 'usb' }
        ]),
        listDir,
        listGrantedRoots: vi.fn().mockResolvedValue([]),
        grantRoot
      }
    }
    renderDialog()
    await flush()

    // Browse onto the USB mount via the path editor.
    await click(document.body.querySelector('[data-testid="grant-access-path-bar"]'))
    const input = pathInput() as HTMLInputElement
    await typeInto(input, '/media/user/usb/sub')
    await keyOn(input, 'Enter')
    await flush()

    expect(listDir).toHaveBeenCalledWith('/media/user/usb/sub')
    // The root crumb tracks the mount, and the menu highlights it rather than /.
    expect(
      document.body.querySelector('[data-testid="grant-access-drive-root"]')?.textContent
    ).toContain('usb')
    expect(driveEntry('/media/user/usb')?.getAttribute('aria-current')).toBe('true')
    expect(driveEntry('/')?.getAttribute('aria-current')).toBeNull()
  })

  it('cancels path editing on Escape without navigating', async () => {
    renderDialog()
    await flush()
    const initialCalls = listDir.mock.calls.length

    await click(document.body.querySelector('[data-testid="grant-access-path-bar"]'))
    const input = pathInput()
    expect(input).not.toBeNull()

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })

    expect(pathInput()).toBeNull()
    expect(document.body.querySelector('[data-testid="grant-access-path-bar"]')).not.toBeNull()
    expect(listDir.mock.calls.length).toBe(initialCalls)
  })

  it('does not treat a click inside the portaled drive menu as an outside dismissal', async () => {
    const onOpenChange = vi.fn()
    act(() => {
      root.render(<GrantFolderAccessDialog open onOpenChange={onOpenChange} />)
    })
    await flush()

    // The real DropdownMenuContent portals to <body>, outside the dialog's DOM. Modal dialogs
    // defer left-button dismissal to the click, so reproduce the pointerdown+click sequence on a
    // node marked like the shared dropdown content.
    const menuContent = document.createElement('div')
    menuContent.setAttribute('data-slot', 'dropdown-menu-content')
    document.body.appendChild(menuContent)
    await act(async () => {
      menuContent.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      menuContent.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    expect(onOpenChange).not.toHaveBeenCalled()
    menuContent.remove()

    // Control: a genuine outside click still dismisses the dialog (proves the guard is selective
    // and that this harness actually reaches Radix's outside-interaction path).
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    await act(async () => {
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      outside.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    outside.remove()
  })

  it('leads the bar with the Home shortcut, divider, then the drive crumb', async () => {
    renderDialog()
    await flush()

    const homeButton = document.body.querySelector('[data-testid="grant-access-crumb-home"]')
    const driveTrigger = document.body.querySelector('[data-testid="grant-access-drive-root"]')
    expect(homeButton).not.toBeNull()
    expect(driveTrigger).not.toBeNull()
    expect(
      (homeButton as Element).compareDocumentPosition(driveTrigger as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('shows a disabled "No other drives" placeholder when only the current drive exists', async () => {
    ;(window as unknown as { api: unknown }).api = {
      localFs: {
        getRoots: vi.fn().mockResolvedValue({ home: HOME, machineName: 'Test Mac' }),
        listDrives: vi.fn().mockResolvedValue([{ path: '/', label: '/' }]),
        listDir,
        listGrantedRoots: vi.fn().mockResolvedValue([]),
        grantRoot
      }
    }
    renderDialog()
    await flush()

    const placeholder = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="grant-access-no-drives"]'
    )
    expect(placeholder).not.toBeNull()
    expect(placeholder?.textContent).toContain('No other drives')
    expect(placeholder?.disabled).toBe(true)
    // Not selectable: clicking changes nothing.
    const callsBefore = listDir.mock.calls.length
    await click(placeholder)
    expect(listDir.mock.calls.length).toBe(callsBefore)
  })

  it('shows the "No other drives" placeholder when no drives were enumerated', async () => {
    ;(window as unknown as { api: unknown }).api = {
      localFs: {
        getRoots: vi.fn().mockResolvedValue({ home: HOME, machineName: 'Test Mac' }),
        listDrives: vi.fn().mockResolvedValue([]),
        listDir,
        listGrantedRoots: vi.fn().mockResolvedValue([]),
        grantRoot
      }
    }
    renderDialog()
    await flush()

    expect(document.body.textContent).toContain('No other drives')
    expect(driveEntry('/')).toBeUndefined()
  })

  it('lists the drives in the root crumb menu and navigates on select', async () => {
    const onOpenChange = vi.fn()
    act(() => {
      root.render(<GrantFolderAccessDialog open onOpenChange={onOpenChange} />)
    })
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
    // Selecting a drive must not dismiss the dialog.
    expect(onOpenChange).not.toHaveBeenCalled()
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
    expect(grantButton?.className).toContain('bg-primary')
    expect(grantButton?.className).toContain('text-primary-foreground')
    expect(grantButton?.className).toContain('disabled:opacity-40')
  })

  it('uses one access-level Tab stop and wraps selection with horizontal arrow keys', async () => {
    renderDialog()
    await flush()

    const group = document.body.querySelector<HTMLElement>('[role="radiogroup"]')
    const radios = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]'))

    expect(group).not.toBeNull()
    expect(group?.getAttribute('aria-label')).toBe('Access level')
    expect(group?.tabIndex).toBe(0)
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1])

    act(() => group?.focus())
    expect(document.activeElement).toBe(radios[0])

    await act(async () => {
      radios[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    expect(document.activeElement).toBe(radios[1])

    await act(async () => {
      radios[1].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    expect(document.activeElement).toBe(radios[0])
  })

  it('shows "Directory could not be accessed." when the grant is rejected', async () => {
    grantRoot.mockRejectedValue(new Error('Directory is outside the granted scope.'))
    renderDialog()
    await flush()

    await click(document.body.querySelector('[data-testid="grant-access-folder-Projects"]'))
    await click(document.body.querySelector('[data-testid="grant-access-grant"]'))
    await confirmGrant()

    expect(document.body.textContent).toContain('Directory could not be accessed.')
    // The failure clears on navigation.
    await click(document.body.querySelector('[data-testid="grant-access-crumb-home"]'))
    expect(document.body.textContent).not.toContain('Directory could not be accessed.')
  })

  it('keeps the selected folder unchanged when confirmation is cancelled', async () => {
    renderDialog()
    await flush()

    await click(document.body.querySelector('[data-testid="grant-access-folder-Projects"]'))
    await click(document.body.querySelector('[data-testid="grant-access-grant"]'))
    expect(
      document.body.querySelector('[data-testid="grant-folder-access-confirmation"]')?.textContent
    ).toContain('Changing Notebook file access will stop active Notebook kernels. Continue?')
    await cancelGrant()

    expect(grantRoot).not.toHaveBeenCalled()
    expect(document.body.querySelector('[data-testid="grant-access-grant"]')).not.toBeNull()
  })

  it('submits one grant and disables actions when Grant is clicked twice before it settles', async () => {
    const resolveGrant = deferGrant()
    renderDialog()
    await flush()

    await click(document.body.querySelector('[data-testid="grant-access-folder-Projects"]'))
    const grantButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="grant-access-grant"]'
    )
    const cancelButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="grant-access-cancel"]'
    )
    await act(async () => {
      grantButton?.click()
      grantButton?.click()
      await Promise.resolve()
    })
    const confirmation = document.body.querySelector(
      '[data-testid="grant-folder-access-confirmation"]'
    )
    const confirmButton = confirmation?.querySelector<HTMLButtonElement>('button:last-of-type')
    await act(async () => {
      confirmButton?.click()
      confirmButton?.click()
      await Promise.resolve()
    })

    expect(grantRoot).toHaveBeenCalledTimes(1)
    expect(grantButton?.disabled).toBe(true)
    expect(cancelButton?.disabled).toBe(true)
    expect(confirmButton?.disabled).toBe(true)
    expect(confirmation?.textContent).toContain('Working…')

    await act(async () => {
      resolveGrant([grantedRoot])
      await Promise.resolve()
    })
  })

  it('ignores a grant response from a closed instance after the dialog reopens', async () => {
    const resolveGrant = deferGrant()
    const onGranted = vi.fn()
    const onOpenChange = vi.fn()
    act(() => {
      root.render(
        <GrantFolderAccessDialog open onOpenChange={onOpenChange} onGranted={onGranted} />
      )
    })
    await flush()

    await click(document.body.querySelector('[data-testid="grant-access-folder-Projects"]'))
    await click(document.body.querySelector('[data-testid="grant-access-grant"]'))
    await confirmGrant()

    act(() => {
      root.render(
        <GrantFolderAccessDialog open={false} onOpenChange={onOpenChange} onGranted={onGranted} />
      )
    })
    act(() => {
      root.render(
        <GrantFolderAccessDialog open onOpenChange={onOpenChange} onGranted={onGranted} />
      )
    })
    await flush()
    onOpenChange.mockClear()

    await act(async () => {
      resolveGrant([grantedRoot])
      await Promise.resolve()
    })

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(onGranted).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Grant folder access')
  })

  it('keeps the selected folder and access fixed while a grant is pending', async () => {
    const resolveGrant = deferGrant()
    const onOpenChange = vi.fn()
    act(() => {
      root.render(<GrantFolderAccessDialog open onOpenChange={onOpenChange} />)
    })
    await flush()

    await click(document.body.querySelector('[data-testid="grant-access-folder-Projects"]'))
    await click(document.body.querySelector('[data-testid="grant-access-grant"]'))
    await confirmGrant()
    listDir.mockClear()

    await click(document.body.querySelector('[data-testid="grant-access-crumb-home"]'))
    await click(document.body.querySelector('[role="radio"][aria-checked="false"]'))
    await click(document.body.querySelector('[data-testid="grant-access-close"]'))

    expect(listDir).not.toHaveBeenCalled()
    expect(
      document.body.querySelector('[data-testid="grant-access-crumb-current"]')?.textContent
    ).toBe('Projects')
    expect(
      Array.from(document.body.querySelectorAll('[role="radio"]')).map((radio) =>
        radio.getAttribute('aria-checked')
      )
    ).toEqual(['true', 'false'])
    expect(onOpenChange).not.toHaveBeenCalled()

    await act(async () => {
      resolveGrant([grantedRoot])
      await Promise.resolve()
    })
  })

  it('does not dismiss the dialog from outside interaction or Escape while granting', async () => {
    const resolveGrant = deferGrant()
    const onOpenChange = vi.fn()
    act(() => {
      root.render(<GrantFolderAccessDialog open onOpenChange={onOpenChange} />)
    })
    await flush()

    await click(document.body.querySelector('[data-testid="grant-access-folder-Projects"]'))
    await click(document.body.querySelector('[data-testid="grant-access-grant"]'))
    await confirmGrant()

    const outside = document.createElement('div')
    document.body.appendChild(outside)
    await act(async () => {
      outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      outside.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    expect(onOpenChange).not.toHaveBeenCalled()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    expect(onOpenChange).not.toHaveBeenCalled()

    outside.remove()
    await act(async () => {
      resolveGrant([grantedRoot])
      await Promise.resolve()
    })
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
    const grantButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="grant-access-grant"]'
    )
    expect(grantButton?.disabled).toBe(false)
    expect(grantButton?.className).toContain('bg-primary')
    expect(grantButton?.className).toContain('hover:bg-primary/80')
    // Switch to read & write before granting.
    await click(document.body.querySelector('[role="radio"][aria-checked="false"]'))
    await click(document.body.querySelector('[data-testid="grant-access-grant"]'))
    await confirmGrant()

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
