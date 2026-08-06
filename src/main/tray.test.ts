import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Menu template item shape captured from Menu.buildFromTemplate.
type MenuTemplateItem = { label?: string; type?: string; click?: () => void }

// A nativeImage stand-in that records template-image flagging so tests can assert the macOS branch.
type FakeImage = {
  kind: 'path' | 'bitmap'
  isTemplate: boolean
  isEmpty: () => boolean
  getSize: () => { width: number; height: number }
  toBitmap: () => Buffer
  resize: () => FakeImage
  setTemplateImage: (value: boolean) => void
}

// Records what the fake Tray was constructed and configured with so assertions can inspect it.
type TrayCall = {
  icon: FakeImage
  tooltip?: string
  contextMenu?: { template: MenuTemplateItem[] }
  clickHandler?: () => void
  doubleClickHandler?: () => void
  rightClickHandler?: () => void
  setImages: FakeImage[]
  poppedMenu?: {
    menu: { template: MenuTemplateItem[] }
    position?: { x: number; y: number }
  }
}

let lastTray: TrayCall | undefined
let lastTemplate: MenuTemplateItem[] | undefined
// When true the fake Tray constructor throws, simulating a platform without a tray host.
let trayShouldThrow = false
// Drives Tray.isDestroyed() on the fake, for the destroyed-tray guard in setTrayIconVariant.
let trayDestroyed = false
// Toggles for the nativeImage doubles, driving the macOS template branch and its fallbacks.
let sourceEmpty = false
let bitmapThrows = false
let sourceBitmap = Buffer.alloc(4 * 4 * 4, 200)
let templateBitmap: Buffer | undefined
let createdFromPaths: string[] = []
// Paths whose fake image reports isEmpty(), to exercise the variant-icon fallback per path.
let emptyPaths: string[] = []

const makeImage = (kind: 'path' | 'bitmap'): FakeImage => {
  const image: FakeImage = {
    kind,
    isTemplate: false,
    isEmpty: () => (kind === 'path' ? sourceEmpty : false),
    getSize: () => ({ width: 4, height: 4 }),
    toBitmap: () => {
      if (bitmapThrows) throw new Error('toBitmap failed')
      return Buffer.from(sourceBitmap)
    },
    resize: () => image,
    setTemplateImage: (value: boolean) => {
      image.isTemplate = value
    }
  }
  return image
}

class FakeTray {
  constructor(icon: FakeImage) {
    if (trayShouldThrow) throw new Error('no tray host')

    lastTray = { icon, setImages: [] }
  }

  setToolTip(tooltip: string): void {
    if (lastTray) lastTray.tooltip = tooltip
  }

  setImage(image: FakeImage): void {
    if (lastTray) lastTray.setImages.push(image)
  }

  isDestroyed(): boolean {
    return trayDestroyed
  }

  setContextMenu(menu: { template: MenuTemplateItem[] }): void {
    if (lastTray) lastTray.contextMenu = menu
  }

  popUpContextMenu(
    menu: { template: MenuTemplateItem[] },
    position?: { x: number; y: number }
  ): void {
    if (lastTray) lastTray.poppedMenu = { menu, position }
  }

  on(event: string, handler: () => void): void {
    if (!lastTray) return
    if (event === 'click') lastTray.clickHandler = handler
    if (event === 'double-click') lastTray.doubleClickHandler = handler
    if (event === 'right-click') lastTray.rightClickHandler = handler
  }
}

vi.mock('electron', () => ({
  Tray: class {
    constructor(icon: FakeImage) {
      return new FakeTray(icon) as unknown as object
    }
  },
  Menu: {
    buildFromTemplate: (template: MenuTemplateItem[]) => {
      lastTemplate = template
      return { template }
    }
  },
  nativeImage: {
    createFromPath: (path: string) => {
      createdFromPaths.push(path)
      const image = makeImage('path')
      if (emptyPaths.includes(path)) image.isEmpty = () => true
      return image
    },
    createFromBitmap: (bitmap: Buffer) => {
      templateBitmap = Buffer.from(bitmap)
      return makeImage('bitmap')
    }
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 1200, y: 800 })
  }
}))

vi.mock('./logger', () => ({
  createLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}))

const { createAppTray, setTrayIconVariant } = await import('./tray')

const originalPlatform = process.platform
const setPlatform = (value: string): void => {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

const findItem = (label: string): MenuTemplateItem => {
  const item = lastTemplate?.find((entry) => entry.label === label)
  expect(item).toBeDefined()
  return item!
}

describe('createAppTray', () => {
  beforeEach(() => {
    lastTray = undefined
    lastTemplate = undefined
    trayShouldThrow = false
    sourceEmpty = false
    bitmapThrows = false
    sourceBitmap = Buffer.alloc(4 * 4 * 4, 200)
    templateBitmap = undefined
    createdFromPaths = []
    trayDestroyed = false
    emptyPaths = []
    // Default the shared cases to a non-darwin platform (full-color icon path).
    setPlatform('linux')
  })

  afterEach(() => {
    setPlatform(originalPlatform)
  })

  it('builds a tray with tooltip and a Show/Hide/Quit context menu', () => {
    const tray = createAppTray({
      iconPath: '/icons/tray.png',
      onShow: vi.fn(),
      onHide: vi.fn(),
      onQuit: vi.fn()
    })

    expect(tray).toBeDefined()
    expect(lastTray?.tooltip).toBe('Open Science')
    expect(lastTray?.contextMenu?.template).toBe(lastTemplate)
    expect(lastTemplate?.filter((item) => item.label).map((item) => item.label)).toEqual([
      'Show',
      'Hide',
      'Quit'
    ])
  })

  it('wires menu items and left click to the provided callbacks', () => {
    const onShow = vi.fn()
    const onHide = vi.fn()
    const onQuit = vi.fn()

    createAppTray({ iconPath: '/icons/tray.png', onShow, onHide, onQuit })

    findItem('Show').click?.()
    expect(onShow).toHaveBeenCalledTimes(1)

    findItem('Hide').click?.()
    expect(onHide).toHaveBeenCalledTimes(1)

    findItem('Quit').click?.()
    expect(onQuit).toHaveBeenCalledTimes(1)

    lastTray?.clickHandler?.()
    expect(onShow).toHaveBeenCalledTimes(2)
  })

  it('builds a headless web menu and left click opens the web UI', () => {
    const onOpenWeb = vi.fn()
    const onCopyWebUrl = vi.fn()
    const onQuit = vi.fn()

    createAppTray({
      iconPath: '/icons/tray.png',
      onShow: vi.fn(),
      onHide: vi.fn(),
      onQuit,
      headless: true,
      onOpenWeb,
      onCopyWebUrl
    })

    expect(lastTray?.tooltip).toBe('Open Science (Web)')
    expect(lastTemplate?.filter((item) => item.label).map((item) => item.label)).toEqual([
      'Open Web UI',
      'Copy URL',
      'Quit'
    ])

    findItem('Open Web UI').click?.()
    findItem('Copy URL').click?.()
    findItem('Quit').click?.()
    lastTray?.clickHandler?.()

    expect(onOpenWeb).toHaveBeenCalledTimes(2)
    expect(onCopyWebUrl).toHaveBeenCalledTimes(1)
    expect(onQuit).toHaveBeenCalledTimes(1)
  })

  describe('on Windows', () => {
    beforeEach(() => {
      setPlatform('win32')
    })

    it('keeps the standard context menu and single-click for the desktop app', () => {
      const onShow = vi.fn()

      createAppTray({
        iconPath: '/icons/tray.png',
        onShow,
        onHide: vi.fn(),
        onQuit: vi.fn()
      })

      // Non-headless desktop: the native menu works, so the headless right-click workaround must NOT
      // apply — setContextMenu is used and single-click shows the window (the #206 regression).
      expect(lastTray?.contextMenu).not.toBeUndefined()
      expect(lastTray?.poppedMenu).toBeUndefined()
      lastTray?.clickHandler?.()
      expect(onShow).toHaveBeenCalledTimes(1)
    })

    it('pops the context menu on right click and opens the web UI on single/double click when headless', () => {
      const onOpenWeb = vi.fn()

      createAppTray({
        iconPath: '/icons/tray.png',
        onShow: vi.fn(),
        onHide: vi.fn(),
        onQuit: vi.fn(),
        headless: true,
        onOpenWeb,
        onCopyWebUrl: vi.fn()
      })

      // Headless: setContextMenu renders invisibly (#48982), so the menu is popped on right-click.
      expect(lastTray?.contextMenu).toBeUndefined()
      lastTray?.rightClickHandler?.()
      expect(lastTray?.poppedMenu?.menu.template).toBe(lastTemplate)
      expect(lastTray?.poppedMenu?.position).toEqual({ x: 1200, y: 800 })

      lastTray?.clickHandler?.()
      lastTray?.doubleClickHandler?.()
      expect(onOpenWeb).toHaveBeenCalledTimes(2)
    })

    describe('variant-following icon', () => {
      const variantArgs = (): Parameters<typeof createAppTray>[0] => ({
        iconPath: '/icons/tray-dark.ico',
        variantIconPaths: { light: '/icons/tray-light.ico', dark: '/icons/tray-dark.ico' },
        onShow: vi.fn(),
        onHide: vi.fn(),
        onQuit: vi.fn()
      })

      it('starts with the tile matching the persisted variant', () => {
        createAppTray({ ...variantArgs(), initialVariant: 'light' })
        expect(createdFromPaths).toEqual(['/icons/tray-light.ico'])

        createdFromPaths = []
        createAppTray({ ...variantArgs(), initialVariant: 'dark' })
        expect(createdFromPaths).toEqual(['/icons/tray-dark.ico'])
      })

      it('starts on the default variant when initialVariant is unset', () => {
        createAppTray(variantArgs())
        expect(createdFromPaths).toEqual(['/icons/tray-light.ico'])
      })

      it('falls back to iconPath when the startup variant asset is unreadable', () => {
        emptyPaths = ['/icons/tray-light.ico']
        createAppTray({ ...variantArgs(), initialVariant: 'light' })

        expect(createdFromPaths).toEqual(['/icons/tray-light.ico', '/icons/tray-dark.ico'])
      })

      it('falls back to iconPath when the variant key is missing from variantIconPaths', () => {
        createAppTray({
          ...variantArgs(),
          variantIconPaths: { dark: '/icons/tray-dark.ico' },
          initialVariant: 'light'
        })

        expect(createdFromPaths).toEqual(['/icons/tray-dark.ico'])
        expect(lastTray?.icon.isEmpty()).toBe(false)
      })

      it('setTrayIconVariant swaps the tile when the settings variant changes', () => {
        const tray = createAppTray({ ...variantArgs(), initialVariant: 'light' })

        setTrayIconVariant(
          tray!,
          { light: '/icons/tray-light.ico', dark: '/icons/tray-dark.ico' },
          'dark'
        )

        expect(createdFromPaths).toEqual(['/icons/tray-light.ico', '/icons/tray-dark.ico'])
        expect(lastTray?.setImages).toHaveLength(1)
        expect(lastTray?.setImages[0]?.isEmpty()).toBe(false)
      })

      it('setTrayIconVariant keeps the current image when the variant asset is unreadable', () => {
        const tray = createAppTray({ ...variantArgs(), initialVariant: 'light' })

        emptyPaths = ['/icons/tray-dark.ico']
        setTrayIconVariant(
          tray!,
          { light: '/icons/tray-light.ico', dark: '/icons/tray-dark.ico' },
          'dark'
        )

        expect(lastTray?.setImages).toHaveLength(0)
      })

      it('setTrayIconVariant is a no-op on a destroyed tray', () => {
        const tray = createAppTray({ ...variantArgs(), initialVariant: 'light' })

        trayDestroyed = true
        setTrayIconVariant(
          tray!,
          { light: '/icons/tray-light.ico', dark: '/icons/tray-dark.ico' },
          'dark'
        )

        expect(createdFromPaths).toEqual(['/icons/tray-light.ico'])
        expect(lastTray?.setImages).toHaveLength(0)
      })
    })
  })

  it('uses the full-color icon (not a template) on non-darwin platforms', () => {
    createAppTray({
      iconPath: '/icons/tray.png',
      onShow: vi.fn(),
      onHide: vi.fn(),
      onQuit: vi.fn()
    })

    expect(lastTray?.icon.kind).toBe('path')
    expect(lastTray?.icon.isTemplate).toBe(false)
  })

  it('returns undefined without throwing when tray construction fails', () => {
    trayShouldThrow = true

    const args = { iconPath: '/icons/tray.png', onShow: vi.fn(), onHide: vi.fn(), onQuit: vi.fn() }
    expect(() => createAppTray(args)).not.toThrow()
    expect(createAppTray(args)).toBe(undefined)
  })

  describe('on macOS', () => {
    beforeEach(() => {
      setPlatform('darwin')
    })

    it('builds a monochrome template image from the app icon', () => {
      createAppTray({
        iconPath: '/icons/tray.png',
        onShow: vi.fn(),
        onHide: vi.fn(),
        onQuit: vi.fn()
      })

      expect(lastTray?.icon.kind).toBe('bitmap')
      expect(lastTray?.icon.isTemplate).toBe(true)
    })

    it('uses a dedicated image source for the monochrome template', () => {
      createAppTray({
        iconPath: '/icons/app.png',
        templateIconPath: '/icons/app-dark.png',
        onShow: vi.fn(),
        onHide: vi.fn(),
        onQuit: vi.fn()
      })

      expect(createdFromPaths[0]).toBe('/icons/app-dark.png')
    })

    it('preserves source transparency when deriving template alpha', () => {
      sourceBitmap = Buffer.alloc(4 * 4 * 4)
      for (let offset = 0; offset < sourceBitmap.length; offset += 4) {
        sourceBitmap.set([20, 20, 20, 255], offset)
      }
      sourceBitmap.set([240, 240, 240, 255], 0)
      sourceBitmap.set([240, 240, 240, 0], 8)
      sourceBitmap.set([240, 240, 240, 128], 12)

      createAppTray({
        iconPath: '/icons/app.png',
        onShow: vi.fn(),
        onHide: vi.fn(),
        onQuit: vi.fn()
      })

      expect(templateBitmap?.subarray(0, 16)).toEqual(
        Buffer.from([
          0,
          0,
          0,
          255, // Opaque bright glyph.
          0,
          0,
          0,
          0, // Opaque dark container.
          0,
          0,
          0,
          0, // Fully transparent bright padding.
          0,
          0,
          0,
          128 // Half-transparent bright antialiasing.
        ])
      )
    })

    it('falls back to the color icon when the template cannot be built', () => {
      bitmapThrows = true

      createAppTray({
        iconPath: '/icons/tray.png',
        onShow: vi.fn(),
        onHide: vi.fn(),
        onQuit: vi.fn()
      })

      // Template construction failed, so the tray still appears using the plain color icon.
      expect(lastTray?.icon.kind).toBe('path')
      expect(lastTray?.icon.isTemplate).toBe(false)
    })

    it('falls back to the color icon when the source icon is empty', () => {
      sourceEmpty = true

      createAppTray({
        iconPath: '/icons/tray.png',
        onShow: vi.fn(),
        onHide: vi.fn(),
        onQuit: vi.fn()
      })

      expect(lastTray?.icon.kind).toBe('path')
      expect(lastTray?.icon.isTemplate).toBe(false)
    })

    it('ignores variantIconPaths and keeps the monochrome template', () => {
      createAppTray({
        iconPath: '/icons/app.png',
        templateIconPath: '/icons/trayTemplate.png',
        variantIconPaths: { light: '/icons/tray-light.ico', dark: '/icons/tray-dark.ico' },
        initialVariant: 'dark',
        onShow: vi.fn(),
        onHide: vi.fn(),
        onQuit: vi.fn()
      })

      // macOS renders the prepared template, never a variant tile.
      expect(lastTray?.icon.isTemplate).toBe(true)
      expect(createdFromPaths).toEqual(['/icons/trayTemplate.png'])
    })
  })
})
