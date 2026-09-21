/// <reference types="electron-vite/node" />
import createArchiveWorker from './archive-task-worker?nodeWorker'
import type { ArchiveTask } from './archive-task-core'
import type { SkillDiscovery } from '../skills/skill-archive-discovery'
import type { verifyMarketplacePackage } from '../skills/marketplace-package'
import type { validateSpecialistZip } from '../specialist/package/zip-adapter'
import type { Zippable } from 'fflate'

// Bound concurrency: importing a bundle must not spawn one memory-heavy worker per contained skill.
// Main retains candidate/transaction ownership. Inputs are cloned, never transferred/detached.
let tail: Promise<unknown> = Promise.resolve()
const run = <T>(task: ArchiveTask): Promise<T> => {
  const pending = tail.then(
    () =>
      new Promise<T>((resolve, reject) => {
        const worker = createArchiveWorker({
          workerData: task,
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 1024 }
        })
        let settled = false
        const finish = (error?: Error, result?: T): void => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          void worker.terminate().then(() => {
            if (error) reject(error)
            else resolve(result!)
          }, reject)
        }
        const timeout = setTimeout(() => finish(new Error('Archive task timed out.')), 60_000)
        worker.once('message', (message: { ok: boolean; result?: T; error?: string }) =>
          finish(message.ok ? undefined : new Error(message.error), message.result)
        )
        worker.once('error', (error) => finish(error))
        worker.once('exit', () => {
          if (!settled) finish(new Error('Archive worker exited without a result.'))
        })
      })
  )
  tail = pending.catch(() => undefined)
  return pending
}
export const zipSettingsFiles = (files: Zippable): Promise<Uint8Array> =>
  run({ kind: 'zip', files })
export const zipSpecialistFiles = (files: Record<string, Uint8Array>): Promise<Uint8Array> =>
  run({ kind: 'specialist-export', files })
export const discoverSkillArchive = async (bytes: Buffer): Promise<SkillDiscovery> => {
  const result = await run<SkillDiscovery>({ kind: 'discover', bytes })
  for (const root of result.roots)
    for (const file of root.files) file.content = Buffer.from(file.content)
  return result
}
export const validateSpecialistArchive = (
  ...[bytes, catalog]: Parameters<typeof validateSpecialistZip>
): Promise<ReturnType<typeof validateSpecialistZip>> => run({ kind: 'specialist', bytes, catalog })
export const verifyMarketplaceArchive = async (
  ...args: Parameters<typeof verifyMarketplacePackage>
): Promise<ReturnType<typeof verifyMarketplacePackage>> => {
  const files = await run<ReturnType<typeof verifyMarketplacePackage>>({
    kind: 'marketplace',
    args
  })
  return files.map((file) => ({ ...file, content: Buffer.from(file.content) }))
}
