import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  html: vi.fn(),
  nativeOpen: vi.fn(),
  nativeSave: vi.fn(),
  focused: vi.fn(),
  allWindows: vi.fn(),
  snapshot: vi.fn(),
  operation: { cancel: vi.fn(), complete: vi.fn(), fail: vi.fn() },
  logger: { warn: vi.fn(), error: vi.fn() }
}))

vi.mock('./file-dialog-save-window', () => ({ showInProcessFileDialog: mocks.html }))
vi.mock('./file-dialog-appearance', () => ({ getFileDialogAppearance: vi.fn() }))
vi.mock('./file-save-target', () => ({ snapshotFileTarget: mocks.snapshot }))
vi.mock('@aipoch/diagnostics/node', () => ({
  createLogger: () => mocks.logger,
  startDiagnosticOperation: () => mocks.operation
}))
vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: mocks.focused,
    getAllWindows: mocks.allWindows
  },
  dialog: {
    showOpenDialog: mocks.nativeOpen,
    showSaveDialog: mocks.nativeSave
  },
  nativeTheme: { shouldUseDarkColors: false }
}))

import { showOpenDialog, showSaveDialog } from './file-dialog-electron'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(() => Object.defineProperty(process, 'platform', originalPlatform))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.snapshot.mockResolvedValue({ path: '/tmp/output.txt', fingerprint: null })
  mocks.nativeOpen.mockResolvedValue({ canceled: true, filePaths: [] })
  mocks.nativeSave.mockResolvedValue({ canceled: true, filePath: '' })
})

describe('desktop save dialog routing', () => {
  it('uses the parented in-process HTML window for Windows saves', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const parent = { isDestroyed: () => false }
    const signal = new AbortController().signal
    const result = {
      canceled: false,
      filePath: '/tmp/output.txt',
      target: { path: '/tmp/output.txt', fingerprint: null }
    }
    mocks.html.mockResolvedValue(result)

    await expect(
      showSaveDialog(parent as never, { defaultPath: '/tmp/output.txt' }, signal)
    ).resolves.toBe(result)
    expect(mocks.html).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'save',
        options: { defaultPath: '/tmp/output.txt' },
        operationId: expect.any(String),
        appearance: expect.objectContaining({ theme: 'light' })
      }),
      parent,
      signal
    )
    expect(mocks.nativeSave).not.toHaveBeenCalled()
  })

  it('uses the focused application window when a save caller has no explicit parent', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const focused = { isDestroyed: () => false }
    mocks.focused.mockReturnValue(focused)
    mocks.html.mockResolvedValue({ canceled: true, filePath: '' })

    await showSaveDialog({ defaultPath: '/tmp/output.txt' })

    expect(mocks.html).toHaveBeenCalledWith(expect.any(Object), focused, undefined)
  })

  it('keeps open dialogs on Electron native dialogs', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const parent = { isDestroyed: () => false }
    const result = { canceled: true, filePaths: [] }
    mocks.nativeOpen.mockResolvedValue(result)

    await expect(showOpenDialog(parent as never, { properties: ['openDirectory'] })).resolves.toBe(
      result
    )
    expect(mocks.nativeOpen).toHaveBeenCalledWith(parent, { properties: ['openDirectory'] })
    expect(mocks.html).not.toHaveBeenCalled()
  })
})
