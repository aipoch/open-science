import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAC_INSTALLATION_ASSISTANT_ACTION_CHANNEL,
  MAC_INSTALLATION_ASSISTANT_RESULT_CHANNEL
} from '../shared/mac-installation'

type WindowListener = (...args: unknown[]) => void

const native = vi.hoisted(() => ({
  parent: { isDestroyed: () => false },
  windowOptions: vi.fn(),
  windows: [] as Array<{
    close: () => void
    emit: (event: string, ...args: unknown[]) => void
    focus: ReturnType<typeof vi.fn>
    loadFile: ReturnType<typeof vi.fn>
    show: ReturnType<typeof vi.fn>
    webContents: {
      emit: (event: string, ...args: unknown[]) => void
      send: ReturnType<typeof vi.fn>
    }
  }>,
  showItemInFolder: vi.fn(),
  checkAccess: vi.fn(),
  app: {
    isPackaged: true,
    getPath: vi.fn(() => '/Volumes/Installer/Open Science.app/Contents/MacOS/Open Science')
  }
}))

vi.mock('electron', () => ({
  app: native.app,
  shell: { showItemInFolder: native.showItemInFolder },
  BrowserWindow: class {
    static getFocusedWindow = (): null => null
    static getAllWindows = (): Array<typeof native.parent> => [native.parent]
    private destroyed = false
    private readonly listeners = new Map<string, WindowListener[]>()
    private readonly webContentsListeners = new Map<string, WindowListener[]>()
    show = vi.fn()
    focus = vi.fn()
    loadFile = vi.fn(async () => undefined)
    loadURL = vi.fn(async () => undefined)
    webContents = {
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      on: vi.fn((event: string, listener: WindowListener) => {
        const listeners = this.webContentsListeners.get(event) ?? []
        listeners.push(listener)
        this.webContentsListeners.set(event, listeners)
      }),
      emit: (event: string, ...args: unknown[]) => {
        for (const listener of this.webContentsListeners.get(event) ?? []) listener(...args)
      }
    }
    constructor(options: unknown) {
      native.windowOptions(options)
      native.windows.push(this)
    }
    once(event: string, listener: WindowListener): void {
      this.listeners.set(event, [listener])
    }
    emit(event: string, ...args: unknown[]): void {
      const listeners = this.listeners.get(event) ?? []
      this.listeners.delete(event)
      for (const listener of listeners) listener(...args)
    }
    close(): void {
      this.destroyed = true
      this.emit('closed')
    }
    destroy(): void {
      this.close()
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
  }
}))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  accessSync: native.checkAccess
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) }
})
vi.mock('./logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn() }),
  diagnosticErrorFields: () => ({})
}))

import {
  createMacInstallationGuard,
  inspectInstallationLocation,
  installMacApplication,
  isMacReadOnlyUpdaterError,
  isReadOnlyMacInstallation,
  showMacInstallationGuidance
} from './mac-installation'

beforeEach(() => {
  vi.restoreAllMocks()
  native.windows.length = 0
  native.checkAccess.mockReset()
  native.showItemInFolder.mockReset()
  native.app.isPackaged = true
  vi.stubGlobal(
    'process',
    Object.defineProperty(Object.create(process), 'platform', { value: 'darwin' })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(mkdtemp).mockReset()
})

describe('mac installation location', () => {
  it('distinguishes read-only, writable, and unknown locations without path guessing', () => {
    expect(
      inspectInstallationLocation('/private/translocated/App.app', () => {
        throw { code: 'EROFS' }
      })
    ).toBe('read-only')
    expect(inspectInstallationLocation('/Volumes/External/App.app', () => {})).toBe('writable')
    expect(
      inspectInstallationLocation('/Applications/App.app', () => {
        throw { code: 'EACCES' }
      })
    ).toBe('unknown')
  })

  it('skips unpackaged and non-mac runtimes', () => {
    native.app.isPackaged = false
    expect(isReadOnlyMacInstallation()).toBe(false)
    native.app.isPackaged = true
    vi.stubGlobal(
      'process',
      Object.defineProperty(Object.create(process), 'platform', { value: 'win32' })
    )
    expect(isReadOnlyMacInstallation()).toBe(false)
    expect(native.checkAccess).not.toHaveBeenCalled()
  })

  it('blocks headless updates without opening the assistant and retains a native read-only result', () => {
    native.checkAccess.mockImplementationOnce(() => {
      throw { code: 'EROFS' }
    })
    const guard = createMacInstallationGuard()
    expect(guard(false)).toBe(true)
    expect(native.windows).toHaveLength(0)
    expect(guard(false)).toBe(false)
    native.checkAccess.mockImplementation(() => {
      throw { code: 'EACCES' }
    })
    expect(guard(false, true)).toBe(true)
  })

  it('opens one automatic assistant that can be dismissed without changing the app', async () => {
    const first = showMacInstallationGuidance('startup')
    expect(showMacInstallationGuidance('update')).toBe(first)
    expect(native.windows).toHaveLength(1)
    expect(native.windowOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ parent: native.parent })
    )
    expect(native.windows[0].loadFile).toHaveBeenCalledWith(
      expect.stringContaining('installation-assistant.html'),
      { query: { reason: 'startup' } }
    )

    native.windows[0].emit('ready-to-show')
    expect(native.windows[0].show).toHaveBeenCalledOnce()
    native.windows[0].webContents.emit(
      'ipc-message',
      {},
      MAC_INSTALLATION_ASSISTANT_ACTION_CHANNEL,
      'continue'
    )
    await first
    expect(native.showItemInFolder).not.toHaveBeenCalled()
  })

  it('joins an installation after the assistant closes and reopens', async () => {
    let rejectStaging!: (error: Error) => void
    const pendingStaging = new Promise<string>((_resolve, reject) => {
      rejectStaging = reject
    })
    const staging = vi.mocked(mkdtemp).mockReturnValue(pendingStaging)
    const first = showMacInstallationGuidance('startup')
    native.windows[0].webContents.emit(
      'ipc-message',
      {},
      MAC_INSTALLATION_ASSISTANT_ACTION_CHANNEL,
      'install'
    )
    native.windows[0].close()
    await first

    const second = showMacInstallationGuidance('update')
    native.windows[1].webContents.emit(
      'ipc-message',
      {},
      MAC_INSTALLATION_ASSISTANT_ACTION_CHANNEL,
      'install'
    )
    expect(staging).toHaveBeenCalledOnce()
    rejectStaging(new Error('Applications is unavailable'))
    await vi.waitFor(() => {
      expect(native.windows[1].webContents.send).toHaveBeenCalledWith(
        MAC_INSTALLATION_ASSISTANT_RESULT_CHANNEL,
        { status: 'error' }
      )
    })
    expect(native.windows[0].webContents.send).not.toHaveBeenCalled()
    native.windows[1].close()
    await second
    staging.mockRejectedValueOnce(new Error('retry could not stage'))
    await expect(installMacApplication()).rejects.toThrow('retry could not stage')
    expect(staging).toHaveBeenCalledTimes(2)
  })

  it.skipIf(process.platform !== 'darwin')(
    'stages and replaces an existing application bundle',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'open-science-install-test-'))
      try {
        const source = join(root, 'source', 'Open Science.app')
        const applications = join(root, 'Applications')
        const destination = join(applications, 'Open Science.app')
        await mkdir(join(source, 'Contents'), { recursive: true })
        await mkdir(destination, { recursive: true })
        await writeFile(join(source, 'Contents', 'version'), 'new')
        await writeFile(join(destination, 'version'), 'old')

        await expect(installMacApplication(source, applications)).resolves.toBe(destination)
        await expect(readFile(join(destination, 'Contents', 'version'), 'utf8')).resolves.toBe(
          'new'
        )
        expect((await readdir(applications)).filter((name) => name.startsWith('.'))).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('requires both the Squirrel error semantics and the macOS runtime', () => {
    const error = Object.assign(
      new Error('Cannot update while running on a read-only volume. details'),
      { code: 8 }
    )
    expect(isMacReadOnlyUpdaterError(error, 'darwin')).toBe(true)
    expect(isMacReadOnlyUpdaterError(error, 'win32')).toBe(false)
    expect(
      isMacReadOnlyUpdaterError(Object.assign(new Error('other failure'), { code: 8 }), 'darwin')
    ).toBe(false)
  })
})
