import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent
} from 'react'
import { useTranslation } from 'react-i18next'

import { APP } from '../../../shared/app-config'
import type { WindowsTitleBarCommand, WindowsTitleBarMenu } from '../../../shared/window-controls'
import { AppLogo } from '@/components/AppLogo'
import { WindowsTitleBarContext, type WindowsTitleBarCommands } from './windows-titlebar-context'
import { isDesktopRenderer } from '@/lib/interface-scale'
import { useInterfaceScaleStore } from '@/stores/interface-scale-store'
import { useThemeStore } from '@/stores/theme-store'

const colorToHex = (color: string): string => {
  // Canvas resolves the existing CSS tokens (including OKLCH) to Electron's sRGB hex format.
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')!
  context.fillStyle = color
  context.fillRect(0, 0, 1, 1)
  return (
    '#' +
    Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
  )
}

const WindowsDesktopFrame = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const { t } = useTranslation()
  const [commands, setCommands] = useState<WindowsTitleBarCommands | null>(null)
  const commandsRef = useRef(commands)
  useLayoutEffect(() => {
    commandsRef.current = commands
  }, [commands])
  const [activeMenu, setActiveMenu] = useState<WindowsTitleBarMenu | null>(null)
  const [focusedMenu, setFocusedMenu] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const headerRef = useRef<HTMLElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const mounted = useRef(true)
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme)
  const scale = useInterfaceScaleStore((state) => state.scale)
  const menus: ReadonlyArray<{ id: WindowsTitleBarMenu; label: string }> = [
    { id: 'file', label: t('File') },
    { id: 'edit', label: t('Edit') },
    { id: 'view', label: t('View') },
    { id: 'help', label: t('Help') }
  ]

  useLayoutEffect(() => {
    mounted.current = true
    document.documentElement.setAttribute('data-windows-titlebar', '')
    return () => {
      mounted.current = false
      document.documentElement.removeAttribute('data-windows-titlebar')
    }
  }, [])

  useEffect(() => {
    let stale = false
    const unsubscribe = window.api.window.onFullScreenChanged?.((fullscreen) => {
      stale = true
      setFullscreen(fullscreen)
    })
    void window.api.window
      .isFullScreen?.()
      .then((fullscreen) => {
        // A newer native event takes precedence over the initial snapshot (including reloads).
        if (!stale) setFullscreen(fullscreen)
      })
      .catch((error: unknown) => console.error('Window fullscreen state query failed', error))
    return () => {
      stale = true
      unsubscribe?.()
    }
  }, [])

  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-windows-titlebar', fullscreen ? 'fullscreen' : '')
    if (fullscreen && headerRef.current?.contains(document.activeElement)) {
      previousFocus.current?.focus({ preventScroll: true })
    }
  }, [fullscreen])

  useEffect(() => {
    const header = headerRef.current
    if (!header) return
    const style = getComputedStyle(header)
    void window.api.window
      .updateTitleBar?.({
        color: colorToHex(style.backgroundColor),
        symbolColor: colorToHex(style.color)
      })
      .catch((error: unknown) => console.error('Title bar appearance update failed', error))
  }, [resolvedTheme, scale])

  const menuButtons = useCallback(
    (): HTMLElement[] =>
      Array.from(headerRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    []
  )
  const focusMenu = useCallback(
    (index: number): void => {
      setFocusedMenu(index)
      menuButtons()[index]?.focus()
    },
    [menuButtons]
  )
  const openMenu = async (menu: WindowsTitleBarMenu, button: HTMLElement): Promise<void> => {
    if (activeMenu) return
    const bounds = button.getBoundingClientRect()
    if (document.activeElement === button && previousFocus.current?.isConnected) {
      previousFocus.current.focus({ preventScroll: true })
    }
    setActiveMenu(menu)
    try {
      const command: WindowsTitleBarCommand | null | undefined =
        await window.api.window.showTitleBarMenu?.({
          menu,
          x: bounds.left,
          y: bounds.bottom,
          settingsEnabled: commandsRef.current?.settingsEnabled ?? false,
          searchEnabled: commandsRef.current?.searchEnabled ?? false,
          labels: {
            Settings: t('Settings'),
            'Close window': t('Close window'),
            Quit: t('Quit', { context: 'verb', ns: 'common' }),
            Undo: t('Undo'),
            Redo: t('Redo'),
            Cut: t('Cut'),
            Copy: t('Copy'),
            Paste: t('Paste'),
            'Select all': t('Select all'),
            Search: t('Search'),
            'Zoom in': t('Zoom in'),
            'Zoom out': t('Zoom out'),
            'Reset zoom': t('Reset zoom'),
            'Full screen': t('Full screen'),
            Documentation: t('Documentation'),
            GitHub: t('GitHub')
          }
        })
      if (!mounted.current) return
      if (command === 'settings' && commandsRef.current?.settingsEnabled)
        commandsRef.current.openSettings()
      if (command === 'search' && commandsRef.current?.searchEnabled)
        commandsRef.current.openSearch()
    } finally {
      if (mounted.current) setActiveMenu(null)
    }
  }
  const requestMenu = (menu: WindowsTitleBarMenu, button: HTMLElement): void => {
    void openMenu(menu, button).catch((error: unknown) =>
      console.error('Application menu failed', error)
    )
  }
  const onMenuKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      focusMenu((index + (event.key === 'ArrowRight' ? 1 : menus.length - 1)) % menus.length)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusMenu(event.key === 'Home' ? 0 : menus.length - 1)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      requestMenu(menus[index].id, event.currentTarget)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      previousFocus.current?.focus()
    }
  }

  useEffect(() => {
    if (fullscreen) return
    let altOnly = false
    const cancelAlt = (): void => {
      altOnly = false
    }
    const focusFromShortcut = (event: globalThis.KeyboardEvent): void => {
      const isAlt = event.type === 'keyup' && event.key === 'Alt' && altOnly
      if (event.type === 'keydown') {
        altOnly =
          event.key === 'Alt' &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          !event.repeat
      } else if (event.key === 'Alt') {
        cancelAlt()
      }
      if (event.defaultPrevented || event.isComposing || event.repeat || activeMenu) {
        cancelAlt()
        return
      }
      const isF10 =
        event.type === 'keydown' &&
        event.key === 'F10' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      if (!isAlt && !isF10) return
      event.preventDefault()
      const buttons = menuButtons()
      if (buttons.includes(document.activeElement as HTMLElement)) {
        previousFocus.current?.focus()
      } else {
        previousFocus.current = document.activeElement as HTMLElement | null
        focusMenu(0)
      }
    }
    window.addEventListener('keyup', focusFromShortcut)
    window.addEventListener('keydown', focusFromShortcut)
    window.addEventListener('blur', cancelAlt)
    return () => {
      window.removeEventListener('keyup', focusFromShortcut)
      window.removeEventListener('keydown', focusFromShortcut)
      window.removeEventListener('blur', cancelAlt)
    }
  }, [activeMenu, menuButtons, focusMenu, fullscreen])

  return (
    <WindowsTitleBarContext.Provider value={setCommands}>
      <header
        ref={headerRef}
        hidden={fullscreen}
        className="windows-titlebar bg-background text-foreground"
        data-testid="windows-titlebar"
      >
        <div className="windows-titlebar-safe-area">
          <div className="flex shrink-0 items-center gap-2 px-3 text-xs select-none">
            <AppLogo alt="" className="size-4 object-contain" />
            <span>{APP.name}</span>
          </div>
          <nav
            role="menubar"
            aria-label={t('Application menu')}
            className="windows-titlebar-menu flex items-center gap-0.5"
          >
            {menus.map(({ id, label }, index) => (
              <button
                key={id}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={activeMenu === id}
                tabIndex={focusedMenu === index ? 0 : -1}
                className="h-7 rounded-md px-2.5 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted"
                onPointerDown={(event) => {
                  // Mouse menus preserve the editor's focus/selection; native Menu owns its popup.
                  if (!menuButtons().includes(document.activeElement as HTMLElement)) {
                    previousFocus.current = document.activeElement as HTMLElement | null
                  }
                  event.preventDefault()
                }}
                onFocus={(event) => {
                  const target = event.relatedTarget
                  if (target instanceof HTMLElement && !menuButtons().includes(target)) {
                    previousFocus.current = target
                  }
                  setFocusedMenu(index)
                }}
                onKeyDown={(event) => onMenuKeyDown(event, index)}
                onClick={(event) => requestMenu(id, event.currentTarget)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <div className="windows-app-content">{children}</div>
    </WindowsTitleBarContext.Provider>
  )
}

export const WindowsTitleBar = ({ children }: { children: ReactNode }): React.JSX.Element =>
  window.api?.platform === 'win32' &&
  isDesktopRenderer() &&
  typeof window.api.window.showTitleBarMenu === 'function' &&
  typeof window.api.window.updateTitleBar === 'function' ? (
    <WindowsDesktopFrame>{children}</WindowsDesktopFrame>
  ) : (
    <>{children}</>
  )
