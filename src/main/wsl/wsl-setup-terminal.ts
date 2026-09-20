import { spawn } from 'node:child_process'

import { resolveWindowsPowerShellExecutable } from '../windows-powershell'

type PowerShellTerminalLauncher = Readonly<{
  open(): Promise<void>
}>

/**
 * Creates a visible, interactive Windows PowerShell terminal for WSL setup.
 *
 * The caller cannot supply a command or arguments. Completion means that Windows opened the
 * terminal process; the interactive shell remains user-owned and its later exit is not observed.
 */
export const createWslSetupPowerShellTerminalLauncher = (
  spawnProcess: typeof spawn = spawn,
  resolveExecutable: () => string = resolveWindowsPowerShellExecutable
): PowerShellTerminalLauncher => ({
  open: () =>
    new Promise((resolve, reject) => {
      const child = spawnProcess('conhost.exe', [resolveExecutable()], {
        detached: true,
        windowsHide: false,
        stdio: 'inherit',
        shell: false
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
})

const wslSetupPowerShellTerminal = createWslSetupPowerShellTerminalLauncher()

export const openWslSetupPowerShellTerminal = (): Promise<void> => wslSetupPowerShellTerminal.open()
