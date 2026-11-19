import { execFile, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isRecordedPosixLeaderCurrent, ownedPosixProcessIdentities } from '../process-tree'
import { inspectWindowsChildJobProcessIds } from '../process-tree-windows'

export type NotebookOwnedMemorySample = {
  sampledAt: number
  complete: boolean
  metric: 'rss' | 'private-bytes-and-working-set'
  processes: Array<{
    pid: number
    birth: string
    rssBytes?: number
    privateBytes?: number
    workingSetBytes?: number
  }>
}

const requireNative = createRequire(import.meta.url)
const MAX_PROCESSES = 256
const bytes = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

// Capture this capability at the original Child owner and retain it with that owner after failed
// cleanup. The sampler cannot authorize release and never reconstructs ownership from a view id.
export const createNotebookMemorySampler = (
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform
): ((signal: AbortSignal) => Promise<NotebookOwnedMemorySample>) => {
  let native: typeof import('@aipoch/process-tree-native') | undefined
  let windowsBirth: string | null | undefined
  if (platform === 'win32' && platform === process.platform) {
    try {
      native = requireNative('@aipoch/process-tree-native')
      windowsBirth = child.pid ? native?.readWindowsResourceBirth(child.pid) : undefined
    } catch {
      /* Missing diagnostics do not affect the owner's release capability. */
    }
  }
  return async (signal) => {
    const result: NotebookOwnedMemorySample = {
      sampledAt: Date.now(),
      complete: false,
      metric: platform === 'win32' ? 'private-bytes-and-working-set' : 'rss',
      processes: []
    }
    if (signal.aborted || platform !== process.platform) return result
    if (platform === 'win32') {
      if (!native || !child.pid || !windowsBirth) return result
      const members = inspectWindowsChildJobProcessIds(child)
      const ids = members ?? [child.pid]
      const retained = ids.slice(0, MAX_PROCESSES).flatMap((pid) => {
        const birth = native!.readWindowsResourceBirth(pid)
        return birth && (pid !== child.pid || birth === windowsBirth) ? [{ pid, birth }] : []
      })
      const sample = await native.sampleWindowsResources(true, retained)
      if (signal.aborted || !sample.supported) return result
      const currentMembers =
        members === undefined ? undefined : inspectWindowsChildJobProcessIds(child)
      result.complete =
        members !== undefined &&
        ids.length <= MAX_PROCESSES &&
        sample.complete &&
        retained.length === ids.length &&
        currentMembers?.length === members.length &&
        currentMembers.every((pid) => members.includes(pid))
      for (const original of retained) {
        const observed = sample.processes.find(
          (entry) => entry.pid === original.pid && entry.birth === original.birth
        )
        if (
          !observed ||
          !bytes(observed.privateBytes) ||
          !bytes(observed.workingSetBytes) ||
          native.readWindowsResourceBirth(original.pid) !== original.birth ||
          (members !== undefined && !currentMembers?.includes(original.pid))
        ) {
          result.complete = false
          continue
        }
        result.processes.push({
          ...original,
          privateBytes: observed.privateBytes,
          workingSetBytes: observed.workingSetBytes
        })
      }
      return result
    }
    if (platform !== 'darwin' && platform !== 'linux') return result
    const owned = ownedPosixProcessIdentities(child)
    const identities = owned.identities.slice(0, MAX_PROCESSES).filter(isRecordedPosixLeaderCurrent)
    result.complete =
      owned.complete &&
      identities.length === owned.identities.length &&
      owned.identities.length <= MAX_PROCESSES
    if (!identities.length) return result
    if (platform === 'linux') {
      for (const identity of identities) {
        if (signal.aborted) {
          result.complete = false
          break
        }
        try {
          const status = await readFile(`/proc/${identity.pid}/status`, {
            encoding: 'utf8',
            signal
          })
          const match = status.length <= 64 * 1024 ? /^VmRSS:\s+(\d+)\s+kB$/m.exec(status) : null
          const rssBytes = match ? Number(match[1]) * 1024 : undefined
          if (!bytes(rssBytes) || !isRecordedPosixLeaderCurrent(identity)) {
            result.complete = false
            continue
          }
          result.processes.push({ pid: identity.pid, birth: identity.birthToken, rssBytes })
        } catch {
          result.complete = false
        }
      }
    } else {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          '/bin/ps',
          ['-p', identities.map(({ pid }) => pid).join(','), '-o', 'pid=,rss='],
          { encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024, signal },
          (error, stdout) => (error ? reject(error) : resolve(stdout))
        )
      })
      const rows = new Map(
        output
          .trim()
          .split('\n')
          .map((line) => {
            const [pid, rss] = line.trim().split(/\s+/).map(Number)
            return [pid, rss * 1024]
          })
      )
      for (const identity of identities) {
        const rssBytes = rows.get(identity.pid)
        if (!bytes(rssBytes) || !isRecordedPosixLeaderCurrent(identity)) {
          result.complete = false
          continue
        }
        result.processes.push({ pid: identity.pid, birth: identity.birthToken, rssBytes })
      }
    }
    return result
  }
}
