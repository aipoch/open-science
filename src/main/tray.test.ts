import { beforeEach, describe, expect, it, vi } from 'vitest'

// Menu template item shape captured from Menu.buildFromTemplate.
type MenuTemplateItem = { label?: string; type?: string; click?: () => void }

// Records what the fake Tray was constructed and configured with so assertions can inspect it.
type TrayCall = {
  icon: unknown
  tooltip?: string
  contextMenu?: { template: MenuTemplateItem[] }
  clickHandler?: () => void
}

let lastTray: TrayCall | undefined
let lastTemplate: MenuTemplateItem[] | undefined
// When true the fake Tray constructor throws, simulating a platform without a tray host.
let trayShouldThrow = false

class FakeTray {
  constructor(icon: unknown) {
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
    constructor(icon: unknown) {
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
    createFromPath: (path: string) => ({ path, isEmpty: () => false })
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

  it('returns undefined without throwing when tray construction fails', () => {
    trayShouldThrow = true

    const args = { iconPath: '/icons/tray.png', onShow: vi.fn(), onHide: vi.fn(), onQuit: vi.fn() }
    expect(() => createAppTray(args)).not.toThrow()
    expect(createAppTray(args)).toBe(undefined)
  })
})
