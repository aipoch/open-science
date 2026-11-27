import type { ChildProcess } from 'node:child_process'
import { vi } from 'vitest'
import { terminateProcessTree, type ProcessTreeKillResult } from '../../process-tree'
import * as windowsProcessTree from '../../process-tree-windows'

export type KernelTreeReap = (
  child: ChildProcess,
  reap: () => Promise<ProcessTreeKillResult>
) => Promise<ProcessTreeKillResult>

export function controlKernelTreeReaping(reapTree: KernelTreeReap): typeof terminateProcessTree {
  if (process.platform !== 'win32') {
    return (child) => reapTree(child, () => terminateProcessTree(child))
  }

  const { spawnWindowsOwnedProcess, reapWindowsOwnedJob } = windowsProcessTree
  const jobChildren = new Map<string, ChildProcess>()
  vi.spyOn(windowsProcessTree, 'spawnWindowsOwnedProcess').mockImplementation(
    (jobName, ...args) => {
      const child = spawnWindowsOwnedProcess(jobName, ...args)
      jobChildren.set(jobName, child)
      return child
    }
  )
  vi.spyOn(windowsProcessTree, 'reapWindowsOwnedJob').mockImplementation(async (jobName) => {
    const child = jobChildren.get(jobName)
    if (!child) return reapWindowsOwnedJob(jobName)
    return (await reapTree(child, async () => ({ reaped: await reapWindowsOwnedJob(jobName) })))
      .reaped
  })
  // Tracked kernels retry by Job identity. Leave their actual termination to the Job reaper above.
  return async (child) =>
    [...jobChildren.values()].includes(child) ? { reaped: false } : terminateProcessTree(child)
}
