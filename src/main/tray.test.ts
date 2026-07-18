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
}

let lastTray: TrayCall | undefined
let lastTemplate: MenuTemplateItem[] | undefined
// When true the fake Tray constructor throws, simulating a platform without a tray host.
let trayShouldThrow = false
// Toggles for the nativeImage doubles, driving the macOS template branch and its fallbacks.
let sourceEmpty = false
let bitmapThrows = false

const makeImage = (kind: 'path' | 'bitmap'): FakeImage => {
  const image: FakeImage = {
    kind,
    isTemplate: false,
    isEmpty: () => (kind === 'path' ? sourceEmpty : false),
    getSize: () => ({ width: 4, height: 4 }),
    toBitmap: () => {
      if (bitmapThrows) throw new Error('toBitmap failed')
      return Buffer.alloc(4 * 4 * 4, 200)
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

    lastTray = { icon }
  }

  setToolTip(tooltip: string): void {
    if (lastTray) lastTray.tooltip = tooltip
  }

  setContextMenu(menu: { template: MenuTemplateItem[] }): void {
    if (lastTray) lastTray.contextMenu = menu
  }

  on(event: string, handler: () => void): void {
    if (event === 'click' && lastTray) lastTray.clickHandler = handler
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
    createFromPath: () => makeImage('path'),
    createFromBitmap: () => makeImage('bitmap')
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

const { createAppTray } = await import('./tray')

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
  })
})
