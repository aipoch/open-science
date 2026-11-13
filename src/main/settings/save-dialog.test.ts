import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  getFocusedWindow: vi.fn(),
  getAllWindows: vi.fn(),
  saveWindow: vi.fn(),
  showSaveDialog: vi.fn()
}))

vi.mock('../file-dialog-save-window', () => ({ showInProcessFileDialog: electron.saveWindow }))
vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: electron.fromWebContents,
    getFocusedWindow: electron.getFocusedWindow,
    getAllWindows: electron.getAllWindows
  },
  dialog: { showSaveDialog: electron.showSaveDialog },
  nativeTheme: { shouldUseDarkColors: false }
}))

const { showSettingsSaveDialog } = await import('./save-dialog')
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => Object.defineProperty(process, 'platform', originalPlatform))

describe('Settings Save As dialog', () => {
  beforeEach(() => {
    electron.saveWindow.mockReset().mockResolvedValue({ canceled: true, filePath: '' })
    electron.fromWebContents.mockReset()
    electron.getFocusedWindow.mockReset().mockReturnValue(undefined)
    electron.getAllWindows.mockReset().mockReturnValue([])
    electron.showSaveDialog.mockReset().mockResolvedValue({ canceled: true, filePath: '' })
  })

  it.each(['win32', 'darwin', 'linux'] as const)(
    'uses the %s owner policy for Settings exports',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform })
      const sender = { id: 42 }
      const parentWindow = { id: 7 }
      const options = { title: 'Export Skill', defaultPath: 'skill.zip' }
      electron.fromWebContents.mockReturnValue(parentWindow)

      await showSettingsSaveDialog(sender as never, options)

      expect(electron.fromWebContents).toHaveBeenCalledWith(sender)
      if (platform === 'win32' || platform === 'darwin') {
        expect(electron.saveWindow).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'save',
            options,
            operationId: expect.any(String),
            appearance: expect.any(Object)
          }),
          parentWindow,
          undefined
        )
        expect(electron.showSaveDialog).not.toHaveBeenCalled()
      } else expect(electron.showSaveDialog).toHaveBeenCalledWith(parentWindow, options)
    }
  )

  it.each(['win32', 'darwin', 'linux'] as const)(
    'falls back to an unparented %s dialog when the sender window no longer exists',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform })
      const sender = { id: 42 }
      const options = { title: 'Export Connector', defaultPath: 'connector.json' }
      electron.fromWebContents.mockReturnValue(null)

      await showSettingsSaveDialog(sender as never, options)

      if (process.platform === 'win32' || process.platform === 'darwin')
        expect(electron.saveWindow).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'save',
            options,
            operationId: expect.any(String),
            appearance: expect.any(Object)
          }),
          undefined,
          undefined
        )
      else expect(electron.showSaveDialog).toHaveBeenCalledWith(options)
    }
  )
})
