import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
const execute = promisify(execFile)
const sysctl = async (key: string): Promise<string> =>
  (
    await execute('sysctl', ['-n', key], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 1024 * 1024
    })
  ).stdout

export const probeRosetta = async (): Promise<boolean> => {
  if (process.platform !== 'darwin' || process.arch !== 'x64') return false
  try {
    return (await sysctl('sysctl.proc_translated')).trim() === '1'
  } catch {
    return false
  }
}
export const probeAvx2 = async (): Promise<boolean> => {
  try {
    if (process.platform === 'linux')
      return /\bavx2\b/i.test(await readFile('/proc/cpuinfo', 'utf8'))
    if (process.platform === 'darwin')
      return /avx2/i.test(await sysctl('machdep.cpu.leaf7_features'))
  } catch {
    /* Preserve the installer's illegal-instruction fallback on unavailable probes. */
  }
  return true
}
