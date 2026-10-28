import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
const require = createRequire(__filename)

/** Kernel birth identity; PID and command lines are never sufficient identity evidence. */
export function processBirthIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    if (process.platform === 'darwin') {
      const native =
        require('@aipoch/process-tree-native') as typeof import('@aipoch/process-tree-native')
      const identity = native.getDarwinProcess(pid)
      return identity?.uniqueId && identity.uniqueId !== '0'
        ? `darwin-proc-uniqueid:${identity.uniqueId}`
        : undefined
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const start = fields[19]
      return start && /^\d+$/.test(start) ? `linux-proc-starttime:${start}` : undefined
    }
    if (process.platform === 'win32') {
      const value = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToFileTimeUtc()`
        ],
        { encoding: 'utf8', timeout: 2000, windowsHide: true }
      ).trim()
      return /^\d+$/.test(value) ? `windows-creation-time:${value}` : undefined
    }
  } catch {
    /* Inability to inspect is not proof of death or ownership. */
  }
  return undefined
}
