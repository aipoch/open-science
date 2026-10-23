import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeDurableJsonFile } from '@aipoch/durable-files'
import type { CondaRuntimeSubsetPlan } from '@aipoch/environment/contracts'
import {
  createReproductionRecipes,
  createWorkflowSlices,
  type ReproductionEvidence
} from '@aipoch/reproducibility'
import { copyFileWithinBudget, digestFileWithinBudget } from '../bounded-file-io'
import { notebookPromptInputPath } from '../notebook/prompt-input-materialization'
import { resolveStorageKey, storageKey } from './provenance-storage'

// Host storage layout and file IO policy never cross into the package implementation.
export const reproductionEvidence = (storageRoot: string): ReproductionEvidence => ({
  resolveFile: (key) => resolveStorageKey(storageRoot, key),
  readEnvironmentLock: (checksum, signal) =>
    readFile(
      resolveStorageKey(
        storageRoot,
        storageKey('runtime', 'provenance', 'environment-locks', checksum + '.json')
      ),
      { encoding: 'utf8', signal }
    )
})
const fileIO = { copyFile: copyFileWithinBudget, digestFile: digestFileWithinBudget }
export const reproductionRecipes = createReproductionRecipes({
  inputPath: notebookPromptInputPath,
  fileIO
})

export const reproductionWorkflowSlices = createWorkflowSlices({
  inputPath: notebookPromptInputPath,
  fileIO
})

// This bounded, disposable cache carries no execution authority. Consume each hint
// once: only a fully compared, reaped and cleaned replay may publish it again.
export const runtimeSubsetCandidateStore = (
  storageRoot: string
): {
  load(scopeChecksum: string): Promise<unknown>
  claim(scopeChecksum: string): Promise<{
    candidate: unknown
    release(returnHint: boolean): Promise<void>
  }>
  save(candidate: CondaRuntimeSubsetPlan): Promise<void>
} => {
  const directory = join(storageRoot, 'runtime', 'provenance', 'runtime-subset-candidates')
  const validKey = (key: string): boolean => /^[a-f0-9]{64}$/u.test(key)
  const checkedDirectory = async (create: boolean): Promise<void> => {
    let parent = await realpath(storageRoot)
    for (const segment of ['runtime', 'provenance', 'runtime-subset-candidates']) {
      const next = join(parent, segment)
      if (create) {
        try {
          await mkdir(next)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      const metadata = await lstat(next)
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(next)) !== next)
        throw new Error('Runtime subset candidate directory must be app-owned.')
      parent = next
    }
  }
  const claim = async (
    scopeChecksum: string
  ): Promise<{
    candidate: unknown
    release(returnHint: boolean): Promise<void>
  }> => {
    if (!validKey(scopeChecksum)) throw new Error('Invalid runtime subset candidate scope.')
    await checkedDirectory(false)
    const consumed = join(directory, `${scopeChecksum}.reading-${process.pid}-${randomUUID()}`)
    await rename(join(directory, `${scopeChecksum}.json`), consumed)
    try {
      const handle = await open(
        consumed,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
      try {
        const metadata = await handle.stat()
        if (!metadata.isFile() || metadata.size > 512 * 1024) {
          return {
            candidate: undefined,
            release: async () => {
              await rm(consumed, { force: true })
            }
          }
        }
        const bytes = Buffer.alloc(metadata.size + 1)
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        if (bytesRead !== metadata.size)
          throw new Error('Runtime subset candidate changed while reading.')
        const candidate: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
        return {
          candidate,
          release: async (returnHint: boolean): Promise<void> => {
            try {
              if (returnHint) {
                try {
                  // Never overwrite a newer successful publication.
                  await link(consumed, join(directory, `${scopeChecksum}.json`))
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                }
              }
            } finally {
              await rm(consumed, { force: true })
            }
          }
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      await rm(consumed, { force: true })
      throw error
    }
  }
  return {
    claim,
    load: async (scopeChecksum: string): Promise<unknown> => {
      const claimed = await claim(scopeChecksum)
      try {
        return claimed.candidate
      } finally {
        await claimed.release(false)
      }
    },
    save: async (candidate: CondaRuntimeSubsetPlan): Promise<void> => {
      if (!validKey(candidate.scopeChecksum)) return
      const bytes = JSON.stringify(candidate)
      if (Buffer.byteLength(bytes) > 512 * 1024) return
      await checkedDirectory(true)
      await writeDurableJsonFile(join(directory, `${candidate.scopeChecksum}.json`), bytes)
      const names = await readdir(directory)
      for (const name of names) {
        const claim =
          /^[a-f0-9]{64}\.reading-([1-9][0-9]*)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.exec(
            name
          ) ??
          /^[a-f0-9]{64}\.json\.([1-9][0-9]*)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/u.exec(
            name
          )
        if (!claim || !Number.isSafeInteger(Number(claim[1]))) continue
        try {
          process.kill(Number(claim[1]), 0)
        } catch (error) {
          // A live or inaccessible reader keeps ownership. Only a confirmed dead
          // process's disposable claim may be removed after a crash.
          if ((error as NodeJS.ErrnoException).code === 'ESRCH')
            await rm(join(directory, name), { force: true })
        }
      }
      const entries = names.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      // Preserve the current hint; eviction affects performance, never correctness.
      const expired = entries.filter((name) => name !== `${candidate.scopeChecksum}.json`).sort()
      for (const name of expired.slice(0, Math.max(0, entries.length - 64)))
        await rm(join(directory, name), { force: true })
    }
  }
}
