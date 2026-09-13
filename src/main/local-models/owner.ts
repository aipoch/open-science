import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, rename, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { LOCAL_MODEL_NOT_INSTALLED, type LocalModelSnapshot } from '../../shared/local-models'
import { DownloadChecksumError, resilientDownload } from '../net/resilient-download'
import { netFetchStandard } from '../skills/net-fetch'
import { readFileWithinLimit, writeDurableJsonFile } from '../storage/durable-json-file'
import { acquireDataRootWriter } from '../storage/migration-state'
import { resolveDataRoot } from '../storage-root'
import { PDF_TABLE_MODEL_REVISIONS, type LocalModelRevision } from './catalog'

type Dependencies = {
  dataRoot?: () => string
  acquireWriter?: () => () => void
  revisions?: readonly LocalModelRevision[]
  download?: typeof resilientDownload
}
class IncompatibleReceiptError extends Error {}
class CorruptModelReceiptError extends Error {}
class UnsafeModelPathError extends Error {}
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const bytes = (revision: LocalModelRevision): number =>
  revision.assets.reduce((total, asset) => total + asset.size, 0)

// One owner per application process. No renderer-provided paths, URLs or revisions are accepted.
export const createLocalModelOwner = (dependencies: Dependencies = {}): LocalModelOwner => {
  const revisions = dependencies.revisions ?? PDF_TABLE_MODEL_REVISIONS
  const recommended = revisions[0]
  if (!recommended) throw new Error('A local model revision is required.')
  for (const revision of revisions) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(revision.revision)) throw new Error('Invalid model revision.')
    for (const asset of revision.assets) {
      if (!/^[a-z0-9][a-z0-9.-]*\.(?:onnx|mjs|wasm|txt)$/.test(asset.file))
        throw new Error('Invalid model asset.')
    }
  }
  const root = dependencies.dataRoot ?? resolveDataRoot
  const acquire = dependencies.acquireWriter ?? acquireDataRootWriter
  const download = dependencies.download ?? resilientDownload
  let snapshot: Omit<LocalModelSnapshot, 'inUse'> = {
    availability: 'notInstalled',
    recommendedRevision: recommended.revision,
    downloadBytes: bytes(recommended),
    installedBytes: 0,
    hasFiles: false,
    transferredBytes: 0,
    updateAvailable: false
  }
  let closed = false
  let initialized: Promise<void> | undefined
  let operation:
    { kind: 'install' | 'remove'; controller: AbortController; done: Promise<void> } | undefined
  const uses = new Set<{ revision?: string }>()
  let usesDrained = Promise.resolve()
  let finishUses: (() => void) | undefined
  const currentSnapshot = (): LocalModelSnapshot => ({ ...snapshot, inUse: uses.size > 0 })

  const directory = async (parts: string[], create = false): Promise<string | undefined> => {
    let path = root()
    if (create) await mkdir(path, { recursive: true })
    for (const part of ['models', 'pdf-tables', ...parts]) {
      path = join(path, part)
      if (create)
        await mkdir(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        })
      const info = await lstat(path).catch((error) => {
        if (missing(error)) return undefined
        throw error
      })
      if (!info) return undefined
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new UnsafeModelPathError('Unsafe model directory.')
    }
    return path
  }
  const regularFile = async (path: string): Promise<boolean> => {
    const info = await lstat(path).catch((error) => {
      if (missing(error)) return undefined
      throw error
    })
    if (!info) return false
    if (!info.isFile() || info.isSymbolicLink())
      throw new UnsafeModelPathError('Unsafe model file.')
    return true
  }
  const validAsset = async (
    path: string,
    asset: LocalModelRevision['assets'][number]
  ): Promise<boolean> => {
    if (!(await regularFile(path))) return false
    if ((await lstat(path)).size !== asset.size) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex') === asset.sha256
  }
  const readInstalled = async (): Promise<LocalModelRevision | undefined> => {
    const base = await directory([])
    if (!base || !(await regularFile(join(base, 'active.json')))) return undefined
    const text = await readFileWithinLimit(join(base, 'active.json'), 4096)
    let receipt: unknown
    try {
      receipt = JSON.parse(text)
    } catch (error) {
      throw new CorruptModelReceiptError('Invalid local model receipt JSON.', { cause: error })
    }
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      !('schemaVersion' in receipt) ||
      receipt.schemaVersion !== 1 ||
      !('revision' in receipt)
    )
      throw new IncompatibleReceiptError()
    const revision = revisions.find((entry) => entry.revision === receipt.revision)
    if (!revision) throw new IncompatibleReceiptError()
    const folder = await directory(['revisions', revision.revision])
    if (!folder) throw new DownloadChecksumError()
    for (const asset of revision.assets) {
      if (!(await validAsset(join(folder, asset.file), asset))) throw new DownloadChecksumError()
    }
    return revision
  }
  const applyInstalled = (revision: LocalModelRevision | undefined): void => {
    snapshot = {
      ...snapshot,
      availability: revision ? 'ready' : 'notInstalled',
      installedRevision: revision?.revision,
      installedBytes: revision ? bytes(revision) : 0,
      updateAvailable: Boolean(revision && revision.revision !== recommended.revision),
      error: undefined
    }
  }
  const fail = (error: unknown, downloading = false): void => {
    snapshot = {
      ...snapshot,
      availability: snapshot.installedRevision ? 'ready' : 'error',
      error:
        error instanceof IncompatibleReceiptError
          ? 'incompatible'
          : error instanceof DownloadChecksumError
            ? 'integrity'
            : downloading &&
                !(error instanceof CorruptModelReceiptError) &&
                !(error instanceof UnsafeModelPathError) &&
                !(error as NodeJS.ErrnoException)?.code
              ? 'download'
              : 'storage'
    }
  }
  const initialize = (): Promise<void> => {
    initialized ??= (async () => {
      let release: (() => void) | undefined
      try {
        release = acquire()
        for (const revision of revisions)
          for (const parent of ['revisions', 'staging']) {
            const folder = await directory([parent, revision.revision])
            if (!folder) continue
            for (const asset of revision.assets)
              for (const suffix of ['', '.part', '.part.meta']) {
                if (await regularFile(join(folder, asset.file + suffix))) {
                  snapshot = { ...snapshot, hasFiles: true }
                }
              }
          }
        applyInstalled(await readInstalled())
      } catch (error) {
        fail(error)
      } finally {
        release?.()
      }
    })()
    return initialized
  }
  const getSnapshot = async (): Promise<LocalModelSnapshot> => {
    await initialize()
    return currentSnapshot()
  }
  const acquireUse = async (): Promise<LocalModelUse> => {
    if (closed) throw new Error('Local model owner is closed.')
    // Initialization owns its own short writer. Never acquire an outer writer before this await.
    await initialize()
    if (closed) throw new Error('Local model owner is closed.')
    if (
      operation?.kind === 'remove' ||
      (operation &&
        (!snapshot.installedRevision || snapshot.installedRevision === recommended.revision))
    )
      throw new Error('Local model management is in progress.')

    // Reserve both protections before the first asynchronous verification. Migration may drain
    // this single writer, but a task using this lease must not reacquire the migration gate.
    const releaseWriter = acquire()
    const use: { revision?: string } = {}
    if (uses.size === 0)
      usesDrained = new Promise<void>((resolve) => {
        finishUses = resolve
      })
    uses.add(use)
    const managementAtAcquisition = operation
    const release = (): void => {
      if (!uses.delete(use)) return
      releaseWriter()
      if (uses.size === 0) finishUses?.()
    }
    try {
      let installed: LocalModelRevision | undefined
      try {
        installed = await readInstalled()
      } catch (error) {
        // A failed old reader must not overwrite download state, even if publication finished
        // before its verification failed. A pending use prevents any new install from starting.
        if (!managementAtAcquisition) fail(error)
        throw error
      }
      if (closed) throw new Error('Local model owner is closed.')
      if (!installed) throw new Error(LOCAL_MODEL_NOT_INSTALLED)
      use.revision = installed.revision
      return {
        revision: installed.revision,
        assets: installed.assets.map((asset) => ({
          file: asset.file,
          path: join(root(), 'models', 'pdf-tables', 'revisions', installed.revision, asset.file),
          size: asset.size,
          sha256: asset.sha256
        })),
        release
      }
    } catch (error) {
      release()
      throw error
    }
  }
  const install = async (): Promise<LocalModelSnapshot> => {
    await initialize()
    if (
      closed ||
      operation ||
      snapshot.error === 'incompatible' ||
      [...uses].some((use) => !use.revision || use.revision === recommended.revision)
    )
      return currentSnapshot()
    const controller = new AbortController()
    let release: () => void
    try {
      release = acquire()
    } catch (error) {
      fail(error)
      return currentSnapshot()
    }
    snapshot = { ...snapshot, availability: 'installing', error: undefined, transferredBytes: 0 }
    const run = async (): Promise<void> => {
      try {
        // Re-read the receipt before mutation. A newer app's receipt is never overwritten.
        let installed: LocalModelRevision | undefined
        try {
          installed = await readInstalled()
        } catch (error) {
          if (!(error instanceof DownloadChecksumError)) throw error
          snapshot = {
            ...snapshot,
            installedRevision: undefined,
            installedBytes: 0,
            updateAvailable: false
          }
        }
        if (installed?.revision === recommended.revision) {
          applyInstalled(installed)
          return
        }
        const staging = (await directory(['staging', recommended.revision], true))!
        snapshot = { ...snapshot, hasFiles: true }
        let completed = 0
        for (const asset of recommended.assets) {
          const target = join(staging, asset.file)
          for (const suffix of ['', '.part', '.part.meta']) await regularFile(target + suffix)
          if (!(await validAsset(target, asset))) {
            await download(asset.url, target, {
              expectedSha256: asset.sha256,
              expectedSize: asset.size,
              signal: controller.signal,
              deps: { fetchImpl: netFetchStandard },
              onProgress: (progress) => {
                snapshot = { ...snapshot, transferredBytes: completed + progress.transferred }
              }
            })
          }
          if (controller.signal.aborted) return
          if (!(await validAsset(target, asset))) throw new DownloadChecksumError()
          completed += asset.size
          snapshot = { ...snapshot, transferredBytes: completed }
        }
        const destination = (await directory(['revisions', recommended.revision], true))!
        for (const asset of recommended.assets) {
          await regularFile(join(destination, asset.file))
          await rename(join(staging, asset.file), join(destination, asset.file))
        }
        const base = (await directory([]))!
        if (controller.signal.aborted) return
        await regularFile(join(base, 'active.json'))
        await writeDurableJsonFile(
          join(base, 'active.json'),
          JSON.stringify({
            schemaVersion: 1,
            revision: recommended.revision,
            installedAt: Date.now()
          })
        )
        applyInstalled(recommended)
      } catch (error) {
        if (!controller.signal.aborted) fail(error, true)
      } finally {
        if (snapshot.availability === 'installing') {
          snapshot = {
            ...snapshot,
            availability: snapshot.installedRevision ? 'ready' : 'notInstalled'
          }
        }
        release()
      }
    }
    const done = run().finally(() => {
      operation = undefined
    })
    operation = { kind: 'install', controller, done }
    return currentSnapshot()
  }
  const cancel = async (): Promise<LocalModelSnapshot> => {
    operation?.controller.abort()
    await operation?.done
    return getSnapshot()
  }
  const remove = async (): Promise<LocalModelSnapshot> => {
    await initialize()
    if (closed || operation || uses.size > 0 || snapshot.error === 'incompatible')
      return currentSnapshot()
    let release: () => void
    try {
      release = acquire()
    } catch (error) {
      fail(error)
      return currentSnapshot()
    }
    const run = async (): Promise<void> => {
      try {
        // A recognized receipt proves the active revision; an unknown schema is a removal barrier.
        try {
          await readInstalled()
        } catch (error) {
          if (!(error instanceof DownloadChecksumError)) throw error
        }
        const base = await directory([])
        if (!base) {
          applyInstalled(undefined)
          return
        }
        if (await regularFile(join(base, 'active.json'))) await unlink(join(base, 'active.json'))
        applyInstalled(undefined)
        // Only catalog-owned files are removed. Unknown revisions and unrelated files are retained.
        for (const revision of revisions)
          for (const parent of ['revisions', 'staging']) {
            const folder = await directory([parent, revision.revision])
            if (!folder) continue
            for (const asset of revision.assets)
              for (const suffix of ['', '.part', '.part.meta']) {
                const path = join(folder, asset.file + suffix)
                if (await regularFile(path)) await unlink(path)
              }
            await rmdir(folder).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOTEMPTY') throw error
            })
          }
        snapshot = { ...snapshot, hasFiles: false }
      } catch (error) {
        fail(error)
      } finally {
        release()
      }
    }
    const done = run().finally(() => {
      operation = undefined
    })
    operation = { kind: 'remove', controller: new AbortController(), done }
    await done
    return currentSnapshot()
  }
  const close = async (): Promise<void> => {
    closed = true
    operation?.controller.abort()
    await initialized
    await operation?.done
    // Application module disposal may time out and continue to this owner. Only the worker
    // owner can release its use after verified termination; a timeout must not revoke it.
    await usesDrained
  }
  return { getSnapshot, install, cancel, remove, acquireUse, close }
}

export type LocalModelUse = Readonly<{
  revision: string
  assets: readonly Readonly<{ file: string; path: string; size: number; sha256: string }>[]
  release(): void
}>

export type LocalModelOwner = {
  acquireUse(): Promise<LocalModelUse>
  close(): Promise<void>
  getSnapshot(): Promise<LocalModelSnapshot>
  install(): Promise<LocalModelSnapshot>
  cancel(): Promise<LocalModelSnapshot>
  remove(): Promise<LocalModelSnapshot>
}
