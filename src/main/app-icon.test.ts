import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppIconElectron } from './app-icon'
import { buildAppIconPreviews, createAppIconController } from './app-icon'

vi.mock('./logger', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}))

// A NativeImage stand-in recording the path it was built from and whether it reports empty.
type FakeImage = {
  path: string
  isEmpty: () => boolean
  resize: (options: { width: number }) => FakeImage
  toDataURL: () => string
}

// A BrowserWindow stand-in capturing the last icon applied via setIcon and its destroyed state.
type FakeWindow = {
  destroyed: boolean
  appliedIcon?: FakeImage
  isDestroyed: () => boolean
  setIcon: (icon: FakeImage) => void
}

const makeWindow = (destroyed = false): FakeWindow => {
  const window: FakeWindow = {
    destroyed,
    isDestroyed: () => window.destroyed,
    setIcon: (icon) => {
      window.appliedIcon = icon
    }
  }
  return window
}

// Paths whose createFromPath yields an empty image (missing/corrupt asset), driving the skip branch.
let emptyPaths: Set<string>

const makeNativeImage = (): AppIconElectron['nativeImage'] => ({
  createFromPath: (path: string) => {
    const image: FakeImage = {
      path,
      isEmpty: () => emptyPaths.has(path),
      resize: () => image,
      toDataURL: () => `data:image/png;base64,${path}`
    }
    return image as unknown as ReturnType<AppIconElectron['nativeImage']['createFromPath']>
  }
})

// Builds an injectable electron surface plus handles to inspect the dock and window-created listener.
const makeElectron = (
  windows: FakeWindow[],
  initialSystemDark = false
): {
  electron: AppIconElectron
  setDockIcon: ReturnType<typeof vi.fn>
  emitWindowCreated: (window: FakeWindow) => void
  setSystemDark: (dark: boolean) => void
} => {
  const setDockIcon = vi.fn()
  let windowCreatedHandler: ((event: unknown, window: FakeWindow) => void) | undefined
  let nativeThemeUpdatedHandler: (() => void) | undefined
  let systemDark = initialSystemDark

  const on = (event: string, handler: (event: unknown, window: FakeWindow) => void): void => {
    if (event === 'browser-window-created') windowCreatedHandler = handler
  }

  const electron: AppIconElectron = {
    app: {
      on,
      dock: { setIcon: setDockIcon },
      isReady: () => true
    },
    getAllWindows: () => windows,
    nativeImage: makeNativeImage(),
    nativeTheme: {
      on: (event: string, handler: () => void): void => {
        if (event === 'updated') nativeThemeUpdatedHandler = handler
      },
      get shouldUseDarkColors(): boolean {
        return systemDark
      }
    }
  } as unknown as AppIconElectron

  return {
    electron,
    setDockIcon,
    emitWindowCreated: (window: FakeWindow) => windowCreatedHandler?.({}, window),
    setSystemDark: (dark: boolean) => {
      systemDark = dark
      nativeThemeUpdatedHandler?.()
    }
  }
}

const variantPaths = { light: '/assets/icon.png', dark: '/assets/icon-dark.png' }

describe('createAppIconController (non-darwin)', () => {
  beforeEach(() => {
    emptyPaths = new Set()
  })

  it('applies the initial variant to existing windows and to windows created later', () => {
    const existing = makeWindow()
    const { electron, emitWindowCreated } = makeElectron([existing])

    createAppIconController({
      electron,
      variantPaths,
      initialVariant: 'dark',
      platform: 'linux'
    })

    expect(existing.appliedIcon?.path).toBe(variantPaths.dark)

    const later = makeWindow()
    emitWindowCreated(later)
    expect(later.appliedIcon?.path).toBe(variantPaths.dark)
  })

  it('re-skins every open window when the variant changes', () => {
    const first = makeWindow()
    const second = makeWindow()
    const { electron } = makeElectron([first, second])

    const controller = createAppIconController({
      electron,
      variantPaths,
      initialVariant: 'light',
      platform: 'linux'
    })
    expect(first.appliedIcon?.path).toBe(variantPaths.light)

    controller.setVariant('dark')

    expect(controller.getVariant()).toBe('dark')
    expect(first.appliedIcon?.path).toBe(variantPaths.dark)
    expect(second.appliedIcon?.path).toBe(variantPaths.dark)
  })

  it('never touches the dock off macOS', () => {
    const { electron, setDockIcon } = makeElectron([makeWindow()])

    const controller = createAppIconController({
      electron,
      variantPaths,
      initialVariant: 'light',
      platform: 'linux'
    })
    controller.setVariant('dark')

    expect(setDockIcon).not.toHaveBeenCalled()
  })

  it('skips setIcon for a destroyed window and an empty asset', () => {
    const destroyed = makeWindow(true)
    const live = makeWindow()
    emptyPaths = new Set([variantPaths.dark])
    const { electron } = makeElectron([destroyed, live])

    createAppIconController({
      electron,
      variantPaths,
      initialVariant: 'dark',
      platform: 'linux'
    })

    // Destroyed window is never touched; the empty dark asset leaves the live window unskinned.
    expect(destroyed.appliedIcon).toBeUndefined()
    expect(live.appliedIcon).toBeUndefined()
  })
})

describe('createAppIconController (darwin)', () => {
  beforeEach(() => {
    emptyPaths = new Set()
  })

  it('leaves the bundled adaptive icon untouched until Theme is announced', () => {
    const window = makeWindow()
    const { electron, setDockIcon } = makeElectron([window])

    const controller = createAppIconController({
      electron,
      variantPaths,
      initialVariant: 'light',
      platform: 'darwin'
    })
    expect(setDockIcon).not.toHaveBeenCalled()
    expect(window.appliedIcon).toBeUndefined()

    controller.setAppearance({ theme: 'dark', followsSystem: false })

    expect(setDockIcon).toHaveBeenCalledTimes(1)
    expect(setDockIcon.mock.calls[0][0].path).toBe(variantPaths.dark)
    expect(window.appliedIcon).toBeUndefined()
  })

  it('keeps following native appearance after the renderer window closes', () => {
    const { electron, setDockIcon, setSystemDark } = makeElectron([], false)
    const controller = createAppIconController({
      electron,
      variantPaths,
      initialVariant: 'dark',
      platform: 'darwin'
    })

    // A stale renderer snapshot says dark, but nativeTheme is authoritative in system mode.
    controller.setAppearance({ theme: 'dark', followsSystem: true })
    expect(setDockIcon.mock.calls[0][0].path).toBe(variantPaths.light)

    setSystemDark(true)
    expect(setDockIcon.mock.calls[1][0].path).toBe(variantPaths.dark)

    // Once the user pins Light, later OS changes must not replace that explicit choice.
    controller.setAppearance({ theme: 'light', followsSystem: false })
    expect(setDockIcon.mock.calls[2][0].path).toBe(variantPaths.light)
    setSystemDark(false)
    expect(setDockIcon).toHaveBeenCalledTimes(3)
  })

  it('ignores the independent app-icon setting because Theme owns the macOS Dock', () => {
    const { electron, setDockIcon } = makeElectron([])
    const controller = createAppIconController({
      electron,
      variantPaths,
      initialVariant: 'light',
      platform: 'darwin'
    })

    controller.setVariant('dark')

    expect(controller.getVariant()).toBe('light')
    expect(setDockIcon).not.toHaveBeenCalled()
  })
})

describe('buildAppIconPreviews', () => {
  beforeEach(() => {
    emptyPaths = new Set()
  })

  it('renders a data URL per known variant, in order', () => {
    const previews = buildAppIconPreviews(makeNativeImage(), variantPaths)

    expect(previews.map((preview) => preview.id)).toEqual(['light', 'dark'])
    expect(previews[0]).toMatchObject({ id: 'light', label: 'Light' })
    expect(previews[0].previewDataUrl).toContain('data:image/png;base64,')
  })

  it('drops a variant whose asset is missing/empty rather than showing a blank tile', () => {
    emptyPaths = new Set([variantPaths.light])

    const previews = buildAppIconPreviews(makeNativeImage(), variantPaths)

    expect(previews.map((preview) => preview.id)).toEqual(['dark'])
  })
})
