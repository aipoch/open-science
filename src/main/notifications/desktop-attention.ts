const MACOS_ATTENTION_DURATION_MS = 5_000
const TASKBAR_ATTENTION_DURATION_MS = 3_000

export type DesktopAttentionWindow = {
  flashFrame(flag: boolean): void
  isDestroyed(): boolean
  isMinimized(): boolean
  isVisible(): boolean
}

export type DesktopAttentionDock = {
  bounce(type: 'critical' | 'informational'): number
  cancelBounce(id: number): void
}

export type DesktopAttentionControllerDeps = {
  platform: NodeJS.Platform
  headless: boolean
  isAppFocused: () => boolean
  isMainWindowHidden: () => boolean
  getMainWindow: () => DesktopAttentionWindow | undefined
  dock?: DesktopAttentionDock
  onError?: (error: unknown) => void
}

export type DesktopAttentionController = {
  request(): void
  clear(): void
}

export type WireDesktopAttentionDeps = {
  app: {
    on(event: 'browser-window-focus' | 'will-quit', listener: () => void): unknown
  }
  taskNotifications: {
    setAttentionHandlers(handlers: DesktopAttentionController): void
  }
  controller: DesktopAttentionController
}

// Owns one bounded native attention request across platforms. macOS gets a longer lease because
// Dock animation cadence is system-controlled; taskbar flashing remains bounded to three seconds.
export const createDesktopAttentionController = (
  deps: DesktopAttentionControllerDeps
): DesktopAttentionController => {
  let bounceId: number | undefined
  let flashingWindow: DesktopAttentionWindow | undefined
  let clearTimer: ReturnType<typeof setTimeout> | undefined

  const reportError = (error: unknown): void => deps.onError?.(error)

  // Stops whichever native mechanism was started without assuming its window still exists.
  const clear = (): void => {
    if (clearTimer !== undefined) {
      clearTimeout(clearTimer)
      clearTimer = undefined
    }

    if (bounceId !== undefined) {
      try {
        deps.dock?.cancelBounce(bounceId)
      } catch (error) {
        reportError(error)
      }
      bounceId = undefined
    }

    if (flashingWindow) {
      try {
        if (!flashingWindow.isDestroyed()) flashingWindow.flashFrame(false)
      } catch (error) {
        reportError(error)
      }
    }
    flashingWindow = undefined
  }

  // Replaces any active request so a later approval receives its own complete platform lease
  // without stacking macOS bounce ids or letting an older timer clear the replacement.
  const request = (): void => {
    if (deps.headless) return
    if (deps.isAppFocused()) {
      clear()
      return
    }
    clear()

    try {
      // macOS owns attention at the app/Dock level. Windows and Linux flash a real taskbar window;
      // a tray-hidden window has no visible taskbar target, so preserve its hidden state silently.
      if (deps.platform === 'darwin' && deps.dock) {
        const requestId = deps.dock.bounce('critical')

        if (requestId < 0) return
        bounceId = requestId
      } else if (deps.platform === 'win32' || deps.platform === 'linux') {
        const window = deps.getMainWindow()

        if (!window || window.isDestroyed()) return
        if (deps.isMainWindowHidden()) return
        if (!window.isVisible() && !window.isMinimized()) return

        flashingWindow = window
        window.flashFrame(true)
      } else {
        return
      }
    } catch (error) {
      bounceId = undefined
      flashingWindow = undefined
      reportError(error)
      return
    }

    const durationMs =
      deps.platform === 'darwin' ? MACOS_ATTENTION_DURATION_MS : TASKBAR_ATTENTION_DURATION_MS
    clearTimer = setTimeout(clear, durationMs)
  }

  return { request, clear }
}

// Binds the Electron-free notification service to native attention after window lifecycle setup.
export const wireDesktopAttention = (deps: WireDesktopAttentionDeps): void => {
  deps.taskNotifications.setAttentionHandlers(deps.controller)
  deps.app.on('browser-window-focus', deps.controller.clear)
  // `before-quit` can be cancelled by migration or close guards. Clear only when Electron commits
  // the quit so a cancelled attempt does not shorten an active attention request.
  deps.app.on('will-quit', deps.controller.clear)
}
