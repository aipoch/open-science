import { describe, expect, it, vi } from 'vitest'

import { openSystemProcessManager } from './system-process-manager'

describe('openSystemProcessManager', () => {
  it('opens Task Manager on Windows', async () => {
    const openPath = vi.fn(async () => '')

    await expect(openSystemProcessManager('win32', openPath)).resolves.toBe(true)
    expect(openPath).toHaveBeenCalledWith('C:\\Windows\\System32\\Taskmgr.exe')
  })

  it('does not open a process manager on other platforms', async () => {
    const openPath = vi.fn(async () => '')

    await expect(openSystemProcessManager('linux', openPath)).resolves.toBe(false)
    expect(openPath).not.toHaveBeenCalled()
  })

  it('reports a desktop shell failure without rejecting the update command', async () => {
    const openPath = vi.fn(async () => 'Task Manager could not be opened')

    await expect(openSystemProcessManager('win32', openPath)).resolves.toBe(false)
  })
})
