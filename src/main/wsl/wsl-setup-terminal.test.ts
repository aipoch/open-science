import { type spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { createWslSetupPowerShellTerminalLauncher } from './wsl-setup-terminal'

describe('WSL setup PowerShell terminal', () => {
  it('opens the resolved system PowerShell in a visible native console without command arguments', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const spawnMock = vi.fn(() => child)
    const spawnProcess = spawnMock as unknown as typeof spawn
    const resolveExecutable = vi.fn(
      () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
    const launcher = createWslSetupPowerShellTerminalLauncher(spawnProcess, resolveExecutable)

    const opening = launcher.open()

    expect(resolveExecutable).toHaveBeenCalledOnce()
    expect(spawnProcess).toHaveBeenCalledWith(
      'conhost.exe',
      ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
      {
        detached: true,
        windowsHide: false,
        stdio: 'inherit',
        shell: false
      }
    )
    expect(spawnMock.mock.calls[0]).toHaveLength(3)

    child.emit('spawn')
    await expect(opening).resolves.toBeUndefined()
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('rejects when Windows cannot open the terminal process', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn
    const launcher = createWslSetupPowerShellTerminalLauncher(spawnProcess, () => 'powershell.exe')
    const opening = launcher.open()

    child.emit('error', new Error('terminal unavailable'))

    await expect(opening).rejects.toThrow('terminal unavailable')
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('reports process opening without waiting for the interactive shell to exit', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn
    const launcher = createWslSetupPowerShellTerminalLauncher(spawnProcess, () => 'powershell.exe')
    const opening = launcher.open()

    child.emit('spawn')

    await expect(opening).resolves.toBeUndefined()
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.unref).toHaveBeenCalledOnce()
  })
})
