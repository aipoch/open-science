// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowsTitleBar } from './WindowsTitleBar'
import { useWindowsTitleBarCommands } from './windows-titlebar-context'
import type { WindowsTitleBarCommand } from '../../../shared/window-controls'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/stores/theme-store', () => ({
  useThemeStore: (select: (state: unknown) => unknown) => select({ resolvedTheme: 'light' })
}))
vi.mock('@/stores/interface-scale-store', () => ({
  useInterfaceScaleStore: (select: (state: unknown) => unknown) => select({ scale: 1 })
}))
vi.mock('@/components/AppLogo', () => ({ AppLogo: () => <img alt="" /> }))

const openSettings = vi.fn()
const openSearch = vi.fn()
const CommandOwner = ({ enabled = true }: { enabled?: boolean }): React.JSX.Element => {
  useWindowsTitleBarCommands({
    settingsEnabled: enabled,
    searchEnabled: enabled,
    openSettings,
    openSearch
  })
  return <textarea aria-label="Editor" defaultValue="selected text" />
}

describe('Windows title bar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.api = {
      platform: 'win32',
      window: {
        showTitleBarMenu: vi.fn().mockResolvedValue(null),
        updateTitleBar: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as Window['api']
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      fillStyle: '',
      fillRect: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray([10, 20, 30, 255]) })
    } as unknown as CanvasRenderingContext2D)
  })
  afterEach(() => {
    cleanup()
    document.documentElement.removeAttribute('data-open-science-web-events')
    vi.restoreAllMocks()
  })

  it.each(['darwin', 'linux'])('preserves the %s shell without extra chrome', (platform) => {
    window.api.platform = platform
    render(
      <WindowsTitleBar>
        <CommandOwner />
      </WindowsTitleBar>
    )
    expect(screen.queryByRole('menubar')).toBeNull()
    expect(window.api.window.updateTitleBar).not.toHaveBeenCalled()
  })
  it('does not add desktop chrome to a Windows Web client', () => {
    document.documentElement.setAttribute('data-open-science-web-events', '')
    render(
      <WindowsTitleBar>
        <CommandOwner />
      </WindowsTitleBar>
    )
    expect(screen.queryByRole('menubar')).toBeNull()
  })
  it('reserves native caption controls, synchronizes theme and leaves children visible', () => {
    render(
      <WindowsTitleBar>
        <CommandOwner />
      </WindowsTitleBar>
    )
    expect(screen.getByRole('menubar', { name: 'Application menu' })).toBeTruthy()
    expect(screen.getAllByRole('menuitem').map((button) => button.textContent)).toEqual([
      'File',
      'Edit',
      'View',
      'Help'
    ])
    expect(document.documentElement.hasAttribute('data-windows-titlebar')).toBe(true)
    expect(window.api.window.updateTitleBar).toHaveBeenCalledWith({
      color: '#0a141e',
      symbolColor: '#0a141e'
    })
    expect(screen.getByRole('textbox')).toBeTruthy()
  })
  it('keeps the title bar above modal and markdown overlays', () => {
    const css = readFileSync(resolve(__dirname, '../assets/main.css'), 'utf8')
    const titlebarZIndex = css.match(/--z-index-titlebar:\s*(\d+)/)?.[1]
    const modalZIndex = css.match(/--z-index-modal:\s*(\d+)/)?.[1]
    const markdownMenuZIndex = css.match(/--z-index-markdown-menu:\s*(\d+)/)?.[1]

    expect(titlebarZIndex).toBeDefined()
    expect(modalZIndex).toBeDefined()
    expect(markdownMenuZIndex).toBeDefined()
    expect(Number(titlebarZIndex)).toBeGreaterThan(Number(modalZIndex))
    expect(Number(titlebarZIndex)).toBeGreaterThan(Number(markdownMenuZIndex))
  })
  it('starts with application commands disabled before the presentation owner mounts', async () => {
    render(
      <WindowsTitleBar>
        <span>Startup</span>
      </WindowsTitleBar>
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    await act(async () => {})
    expect(window.api.window.showTitleBarMenu).toHaveBeenCalledWith(
      expect.objectContaining({ settingsEnabled: false, searchEnabled: false })
    )
  })
  it('hides fullscreen chrome and shortcuts, restores them on exit and removes the listener', async () => {
    let onFullscreen: (fullscreen: boolean) => void = () => undefined
    const unsubscribe = vi.fn()
    window.api.window.onFullScreenChanged = vi.fn((listener) => {
      onFullscreen = listener
      return unsubscribe
    })
    window.api.window.isFullScreen = vi.fn().mockResolvedValue(true)
    const view = render(
      <WindowsTitleBar>
        <CommandOwner />
      </WindowsTitleBar>
    )
    await act(async () => {})
    expect(screen.queryByRole('menubar')).toBeNull()
    expect(document.documentElement.getAttribute('data-windows-titlebar')).toBe('fullscreen')
    const editor = screen.getByRole('textbox')
    editor.focus()
    fireEvent.keyDown(window, { key: 'F10' })
    expect(document.activeElement).toBe(editor)
    act(() => onFullscreen(false))
    fireEvent.keyDown(window, { key: 'F10' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'File' }))
    act(() => onFullscreen(true))
    expect(document.activeElement).toBe(editor)
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(document.documentElement.hasAttribute('data-windows-titlebar')).toBe(false)
  })
  it('ignores an initial fullscreen snapshot superseded by a native event', async () => {
    let resolveSnapshot!: (fullscreen: boolean) => void
    let onFullscreen!: (fullscreen: boolean) => void
    window.api.window.isFullScreen = () =>
      new Promise((resolve) => {
        resolveSnapshot = resolve
      })
    window.api.window.onFullScreenChanged = (listener) => {
      onFullscreen = listener
      return vi.fn()
    }
    render(
      <WindowsTitleBar>
        <CommandOwner />
      </WindowsTitleBar>
    )
    act(() => onFullscreen(true))
    await act(async () => resolveSnapshot(false))
    expect(screen.queryByRole('menubar')).toBeNull()
  })
  it('keeps mouse editing focus and routes the selected command through the current owner', async () => {
    vi.mocked(window.api.window.showTitleBarMenu!).mockResolvedValue('settings')
    render(
      <WindowsTitleBar>
        <CommandOwner />
      </WindowsTitleBar>
    )
    const editor = screen.getByRole('textbox') as HTMLTextAreaElement
    editor.focus()
    editor.setSelectionRange(0, 8)
    const file = screen.getByRole('menuitem', { name: 'File' })
    fireEvent.pointerDown(file)
    fireEvent.click(file)
    await act(async () => {})
    expect(document.activeElement).toBe(editor)
    expect(editor.selectionStart).toBe(0)
    expect(editor.selectionEnd).toBe(8)
    expect(openSettings).toHaveBeenCalledOnce()
    expect(window.api.window.showTitleBarMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        menu: 'file',
        settingsEnabled: true,
        labels: expect.objectContaining({ Settings: 'Settings' })
      })
    )
  })
  it('uses Alt/F10 and arrow navigation with Escape focus restoration', async () => {
    render(
      <WindowsTitleBar>
        <CommandOwner />
      </WindowsTitleBar>
    )
    const editor = screen.getByRole('textbox')
    editor.focus()
    fireEvent.keyDown(window, { key: 'Alt' })
    fireEvent.keyUp(window, { key: 'Alt' })
    const file = screen.getByRole('menuitem', { name: 'File' })
    expect(document.activeElement).toBe(file)
    fireEvent.keyDown(file, { key: 'ArrowRight' })
    const edit = screen.getByRole('menuitem', { name: 'Edit' })
    expect(document.activeElement).toBe(edit)
    fireEvent.keyDown(edit, { key: 'ArrowDown' })
    await act(async () => {})
    expect(document.activeElement).toBe(editor)
    expect(window.api.window.showTitleBarMenu).toHaveBeenCalledWith(
      expect.objectContaining({ menu: 'edit' })
    )
    fireEvent.keyDown(edit, { key: 'Escape' })
    expect(document.activeElement).toBe(editor)
    fireEvent.keyDown(window, { key: 'F10' })
    expect(document.activeElement).toBe(file)
  })
  it.each(['chord', 'window switch'])('leaves editing focus intact after an Alt %s', (sequence) => {
    render(
      <WindowsTitleBar>
        <CommandOwner />
      </WindowsTitleBar>
    )
    const editor = screen.getByRole('textbox')
    editor.focus()
    fireEvent.keyDown(window, { key: 'Alt' })
    if (sequence === 'chord') fireEvent.keyDown(window, { key: 'x', altKey: true })
    else fireEvent.blur(window)
    fireEvent.keyUp(window, { key: 'Alt' })
    expect(document.activeElement).toBe(editor)
  })
  it('restores the editing target when Tab enters the menubar', async () => {
    render(
      <WindowsTitleBar>
        <CommandOwner />
      </WindowsTitleBar>
    )
    const editor = screen.getByRole('textbox')
    editor.focus()
    const file = screen.getByRole('menuitem', { name: 'File' })
    file.focus()
    fireEvent.keyDown(file, { key: 'ArrowRight' })
    const edit = screen.getByRole('menuitem', { name: 'Edit' })
    fireEvent.keyDown(edit, { key: 'Escape' })
    expect(document.activeElement).toBe(editor)
    edit.focus()
    fireEvent.keyDown(edit, { key: 'ArrowDown' })
    await act(async () => {})
    expect(document.activeElement).toBe(editor)
    expect(window.api.window.showTitleBarMenu).toHaveBeenCalledWith(
      expect.objectContaining({ menu: 'edit' })
    )
  })
  it('uses the new presentation owner if state changes while a native menu is open', async () => {
    let complete!: (command: WindowsTitleBarCommand | null) => void
    vi.mocked(window.api.window.showTitleBarMenu!).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve
      })
    )
    const ChangingOwner = (): React.JSX.Element => {
      const [active, setActive] = useState(true)
      useWindowsTitleBarCommands({
        settingsEnabled: active,
        searchEnabled: active,
        openSettings: () => {
          if (active) openSettings()
        },
        openSearch
      })
      return <button onClick={() => setActive(false)}>Block</button>
    }
    render(
      <WindowsTitleBar>
        <ChangingOwner />
      </WindowsTitleBar>
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    fireEvent.click(screen.getByRole('button', { name: 'Block' }))
    await act(async () => {
      complete('settings')
    })
    expect(openSettings).not.toHaveBeenCalled()
  })
})
