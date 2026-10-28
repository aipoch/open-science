import { readFileSync } from 'node:fs'

// Kernel receipts predate the desktop/Node split. Keep their raw Linux tokens byte-compatible:
// a different process token only disproves identity; a matching token never authorizes a signal.
export const readProcessStartToken = (pid: number): string | undefined => {
  if (process.platform !== 'linux') return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const lastParen = stat.lastIndexOf(')')
    if (lastParen === -1) return undefined
    const starttime = stat
      .slice(lastParen + 1)
      .trim()
      .split(/\s+/)[19]
    return starttime !== undefined && /^\d+$/.test(starttime) ? starttime : undefined
  } catch {
    return undefined
  }
}

// Only the kernel's canonical lowercase boot UUID proves a reboot. Case changes, uptime and
// wall-clock observations must not release a receipt that may still belong to a live process.
const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const isValidBootToken = (value: unknown): value is string =>
  typeof value === 'string' && BOOT_ID_RE.test(value)

export const readBootToken = (): string | undefined => {
  if (process.platform !== 'linux') return undefined
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    return isValidBootToken(id) ? id : undefined
  } catch {
    return undefined
  }
}

export const bootTokenProvesReboot = (
  recorded: string | undefined,
  current: string | undefined
): boolean => isValidBootToken(recorded) && isValidBootToken(current) && recorded !== current
