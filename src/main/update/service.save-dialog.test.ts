import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  getPath: vi.fn(() => '/Users/example/Downloads')
}))

vi.mock('electron', () => ({
  app: {
    getPath: electron.getPath,
    getVersion: () => '0.2.0'
  },
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => []
  },
  dialog: { showSaveDialog: electron.showSaveDialog },
  shell: {
    openExternal: vi.fn(async () => {}),
    openPath: vi.fn(async () => '')
  }
}))

import { UpdateService } from './service'

describe('UpdateService installer save dialog', () => {
  it('uses the active native locale for the macOS save panel title', async () => {
    electron.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: '/Users/example/Downloads/OpenScience.dmg'
    })
    const translate = vi.fn((key: string) => `localized:${key}`)
    const service = new UpdateService({
      platform: 'darwin',
      currentVersion: '0.2.0',
      translate
    })

    const result = await service['resolveSavePath']('OpenScience.dmg')

    expect(result).toBe('/Users/example/Downloads/OpenScience.dmg')
    expect(translate).toHaveBeenCalledWith('Save the update installer')
    expect(electron.showSaveDialog).toHaveBeenCalledWith({
      defaultPath: join('/Users/example/Downloads', 'OpenScience.dmg'),
      title: 'localized:Save the update installer'
    })
  })
})
