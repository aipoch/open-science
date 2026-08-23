import { randomUUID } from 'node:crypto'
import { open, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

export type StartupStorageKind = 'typical' | 'likely-slow-disk' | 'slow-disk-or-scanner' | 'unknown'

export type StartupStorageProbeResult = {
  sequentialMs: number
  syncWriteMs: number
  kind: StartupStorageKind
  timedOut?: boolean
}

export type IsolatedStartupStorageProbe = {
  result: Promise<StartupStorageProbeResult>
  terminate: () => Promise<void>
}

type StartupStorageProbeDeps = {
  probeDir: string
  probePath?: string
  now?: () => number
  isolate?: (input: StartupStorageProbeDeps) => IsolatedStartupStorageProbe
}

const SEQUENTIAL_BYTES = 64 * 1024
const SYNC_WRITE_BYTES = 4096
const SYNC_WRITE_COUNT = 8
const PROBE_FILE = '.open-science-startup-probe'
const LIKELY_SLOW_MS = 200
const SCANNER_MS = 1000
const UNKNOWN_RESULT: StartupStorageProbeResult = {
  sequentialMs: 0,
  syncWriteMs: 0,
  kind: 'unknown'
}

const classify = (syncWriteMs: number): StartupStorageKind => {
  if (syncWriteMs >= SCANNER_MS) return 'slow-disk-or-scanner'
  if (syncWriteMs >= LIKELY_SLOW_MS) return 'likely-slow-disk'
  return 'typical'
}

const exclusiveProbePath = (probeDir: string): string =>
  join(probeDir, `${PROBE_FILE}-${randomUUID()}`)

const removeProbeFile = async (probePath: string): Promise<void> => {
  await unlink(probePath).catch(() => undefined)
}

const timedOutResult = (timeoutMs: number): StartupStorageProbeResult => ({
  sequentialMs: timeoutMs,
  syncWriteMs: timeoutMs,
  kind: 'slow-disk-or-scanner',
  timedOut: true
})

// Bounded, path-free disk probe. Distinguishes a warm SSD from HDD/antivirus stalls without logging
// filesystem locations. Failures are swallowed so diagnostics never delay or abort startup.
export const probeStartupStorage = async (
  deps: StartupStorageProbeDeps
): Promise<StartupStorageProbeResult> => {
  const now = deps.now ?? Date.now
  const probePath = deps.probePath ?? exclusiveProbePath(deps.probeDir)
  const sequential = Buffer.alloc(SEQUENTIAL_BYTES, 7)
  const chunk = Buffer.alloc(SYNC_WRITE_BYTES, 9)
  let created = false
  try {
    const sequentialStarted = now()
    await writeFile(probePath, sequential, { flag: 'wx' })
    created = true
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
    return UNKNOWN_RESULT
  } finally {
    if (created) await removeProbeFile(probePath)
  }
}

// Self-contained CJS worker so a stalled fsync can be terminated without blocking or leaking onto
// the Electron main thread. Keep this source free of app imports; packaged main bundles cannot be
// used as worker_threads entry points.
const isolatedProbeWorkerSource = `'use strict'
const { parentPort, workerData } = require('node:worker_threads')
const { open, readFile, unlink, writeFile } = require('node:fs/promises')
const sequentialBytes = ${SEQUENTIAL_BYTES}
const syncWriteBytes = ${SYNC_WRITE_BYTES}
const syncWriteCount = ${SYNC_WRITE_COUNT}
const likelySlowMs = ${LIKELY_SLOW_MS}
const scannerMs = ${SCANNER_MS}
const unknown = { sequentialMs: 0, syncWriteMs: 0, kind: 'unknown' }
const classify = (syncWriteMs) =>
  syncWriteMs >= scannerMs
    ? 'slow-disk-or-scanner'
    : syncWriteMs >= likelySlowMs
      ? 'likely-slow-disk'
      : 'typical'
const probePath = typeof workerData?.probePath === 'string' ? workerData.probePath : ''
void (async () => {
  let created = false
  try {
    if (!probePath) throw new Error('missing probe path')
    const sequential = Buffer.alloc(sequentialBytes, 7)
    const chunk = Buffer.alloc(syncWriteBytes, 9)
    const sequentialStarted = Date.now()
    await writeFile(probePath, sequential, { flag: 'wx' })
    created = true
    await readFile(probePath)
    const sequentialMs = Math.max(0, Date.now() - sequentialStarted)
    const syncStarted = Date.now()
    for (let index = 0; index < syncWriteCount; index += 1) {
      const handle = await open(probePath, 'w')
      try {
        await handle.write(chunk)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    const syncWriteMs = Math.max(0, Date.now() - syncStarted)
    parentPort.postMessage({ sequentialMs, syncWriteMs, kind: classify(syncWriteMs) })
  } catch {
    parentPort.postMessage(unknown)
  } finally {
    if (created) await unlink(probePath).catch(() => undefined)
  }
})()
`

const startIsolatedProbe = (deps: StartupStorageProbeDeps): IsolatedStartupStorageProbe => {
  const probePath = deps.probePath ?? exclusiveProbePath(deps.probeDir)
  let worker: Worker
  try {
    worker = new Worker(isolatedProbeWorkerSource, {
      eval: true,
      workerData: { probePath }
    })
  } catch {
    return {
      result: Promise.resolve(UNKNOWN_RESULT),
      terminate: async () => undefined
    }
  }
  const result = new Promise<StartupStorageProbeResult>((resolve) => {
    let settled = false
    const finish = (value: StartupStorageProbeResult): void => {
      if (settled) return
      settled = true
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      resolve(value)
    }
    const onMessage = (value: unknown): void => {
      if (
        typeof value === 'object' &&
        value !== null &&
        'sequentialMs' in value &&
        'syncWriteMs' in value &&
        'kind' in value
      ) {
        finish(value as StartupStorageProbeResult)
        return
      }
      finish(UNKNOWN_RESULT)
    }
    const onError = (): void => finish(UNKNOWN_RESULT)
    const onExit = (): void => finish(UNKNOWN_RESULT)
    worker.once('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
  })
  return {
    result,
    terminate: async () => {
      await worker.terminate().catch(() => undefined)
      await removeProbeFile(probePath)
    }
  }
}

export const timedStartupStorageProbe = async (
  deps: StartupStorageProbeDeps,
  timeoutMs: number
): Promise<StartupStorageProbeResult> => {
  const isolated = (deps.isolate ?? startIsolatedProbe)(deps)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<StartupStorageProbeResult>((resolve) => {
    timer = setTimeout(() => resolve(timedOutResult(timeoutMs)), timeoutMs)
    timer.unref?.()
  })
  try {
    const result = await Promise.race([isolated.result, timeout])
    if (result.timedOut) await isolated.terminate()
    return result
  } finally {
    if (timer) clearTimeout(timer)
  }
}
