import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  showSaveDialog: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  dialog: { showSaveDialog: electron.showSaveDialog }
}))

const { showSettingsSaveDialog } = await import('./save-dialog')

describe('Settings Save As dialog', () => {
  beforeEach(() => {
    electron.fromWebContents.mockReset()
    electron.showSaveDialog.mockReset().mockResolvedValue({ canceled: true, filePath: '' })
  })

  it('attaches the dialog to the IPC sender window', async () => {
    const sender = { id: 42 }
    const parentWindow = { id: 7 }
    const options = { title: 'Export Skill', defaultPath: 'skill.zip' }
    electron.fromWebContents.mockReturnValue(parentWindow)

    await showSettingsSaveDialog(sender as never, options)

    expect(electron.fromWebContents).toHaveBeenCalledWith(sender)
    expect(electron.showSaveDialog).toHaveBeenCalledWith(parentWindow, options)
  })

  it('falls back to an unparented dialog when the sender window no longer exists', async () => {
    const sender = { id: 42 }
    const options = { title: 'Export Connector', defaultPath: 'connector.json' }
    electron.fromWebContents.mockReturnValue(null)

    await showSettingsSaveDialog(sender as never, options)

    expect(electron.showSaveDialog).toHaveBeenCalledWith(options)
  })
})
