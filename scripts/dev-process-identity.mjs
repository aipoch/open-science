/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

const run = promisify(execFile)
const require = createRequire(import.meta.url)

// PID existence is insufficient after a grace period. Use the kernel process birth identity,
// including the existing native unique-id reader on macOS, before every escalation.
export async function inspectDevProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid development process PID.')
  try {
    if (process.platform === 'darwin') {
      const native = require('@aipoch/process-tree-native')
      const identity = native.getDarwinProcess(pid)
      if (!identity) return undefined
      const argv = native.getDarwinProcessArguments(pid)
      // A dying process may retain its birth identity after its argv has disappeared. Keep
      // polling that identity; admission still requires a readable matching entry below.
      return { birth: identity.uniqueId, ppid: identity.ppid, argv }
    }
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/)
      if (fields[0] === 'Z') return undefined
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean)
      if (!/^\d+$/.test(fields[19])) throw new Error('Missing process birth identity.')
      return { birth: fields[19], ppid: Number(fields[1]), argv }
    }
    if (process.platform === 'win32') {
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ParentProcessId,CommandLine,@{n='Birth';e={$_.CreationDate.ToUniversalTime().Ticks.ToString()}} | ConvertTo-Json -Compress`
        ],
        // Cold Windows CIM initialization can exceed three seconds. Match the existing
        // legacy-service process inspection budget; registration allows additional IPC time.
        { timeout: 5000, windowsHide: true }
      )
      if (!stdout.trim()) return undefined
      const info = JSON.parse(stdout)
      if (!info.Birth) throw new Error('Missing process birth identity.')
      return { birth: info.Birth, ppid: info.ParentProcessId, commandLine: info.CommandLine }
    }
    throw new Error(`Development process supervision is unavailable on ${process.platform}.`)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined
    throw error
  }
}

export function hasDevEntry(info, entry) {
  if (info.argv) return info.argv.includes(entry)
  const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[\\s"])${escaped}(?:[\\s"]|$)`, 'i').test(info.commandLine)
}

export async function signalDevProcess(pid, birth, signal, inspect = inspectDevProcess) {
  const current = await inspect(pid)
  if (!current || current.birth !== birth) return false
  try {
    process.kill(pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  return true
}
