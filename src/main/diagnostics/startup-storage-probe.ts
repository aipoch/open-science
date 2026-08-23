import { open, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type StartupStorageKind = 'typical' | 'likely-slow-disk' | 'slow-disk-or-scanner' | 'unknown'

export type StartupStorageProbeResult = {
  sequentialMs: number
  syncWriteMs: number
  kind: StartupStorageKind
  timedOut?: boolean
}

type StartupStorageProbeDeps = {
  probeDir: string
  now?: () => number
}

const SEQUENTIAL_BYTES = 64 * 1024
const SYNC_WRITE_BYTES = 4096
const SYNC_WRITE_COUNT = 8
const PROBE_FILE = '.open-science-startup-probe'
const LIKELY_SLOW_MS = 200
const SCANNER_MS = 1000

const classify = (syncWriteMs: number): StartupStorageKind => {
  if (syncWriteMs >= SCANNER_MS) return 'slow-disk-or-scanner'
  if (syncWriteMs >= LIKELY_SLOW_MS) return 'likely-slow-disk'
  return 'typical'
}

// Bounded, path-free disk probe. Distinguishes a warm SSD from HDD/antivirus stalls without logging
// filesystem locations. Failures are swallowed so diagnostics never delay or abort startup.
export const probeStartupStorage = async (
  deps: StartupStorageProbeDeps
): Promise<StartupStorageProbeResult> => {
  const now = deps.now ?? Date.now
  const probePath = join(deps.probeDir, PROBE_FILE)
  const sequential = Buffer.alloc(SEQUENTIAL_BYTES, 7)
  const chunk = Buffer.alloc(SYNC_WRITE_BYTES, 9)
  try {
    const sequentialStarted = now()
    await writeFile(probePath, sequential)
    await readFile(probePath)
    const sequentialMs = Math.max(0, now() - sequentialStarted)

    const syncStarted = now()
    for (let index = 0; index < SYNC_WRITE_COUNT; index += 1) {
      const handle = await open(probePath, 'w')
      try {
        await handle.write(chunk)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    const syncWriteMs = Math.max(0, now() - syncStarted)
    return { sequentialMs, syncWriteMs, kind: classify(syncWriteMs) }
  } catch {
    return { sequentialMs: 0, syncWriteMs: 0, kind: 'unknown' }
  } finally {
    await unlink(probePath).catch(() => undefined)
  }
}

export const timedStartupStorageProbe = async (
  deps: StartupStorageProbeDeps & {
    probe?: (input: StartupStorageProbeDeps) => Promise<StartupStorageProbeResult>
  },
  timeoutMs: number
): Promise<StartupStorageProbeResult> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<StartupStorageProbeResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          sequentialMs: timeoutMs,
          syncWriteMs: timeoutMs,
          kind: 'slow-disk-or-scanner',
          timedOut: true
        }),
      timeoutMs
    )
    timer.unref?.()
  })
  const probe = deps.probe ?? probeStartupStorage
  try {
    return await Promise.race([probe(deps), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
