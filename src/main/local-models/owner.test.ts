import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadChecksumError } from '../net/resilient-download'
import { createLocalModelOwner } from './owner'
import type { LocalModelRevision } from './catalog'
import type { DownloadProgress } from '../../shared/download-progress'
import {
  acquireDataRootWriter,
  beginMigration,
  endMigration,
  waitForDataRootWriters
} from '../storage/migration-state'
import { composeApplicationRuntime } from '../application-runtime'
import * as durableJson from '../storage/durable-json-file'

vi.mock('electron', () => ({
  net: {},
  app: { isPackaged: false, getPath: () => tmpdir() },
  dialog: {}
}))
const roots: string[] = []
beforeEach(() => vi.clearAllMocks())
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const content = Buffer.from('model fixture')
const revision = (name: string): LocalModelRevision => ({
  revision: name,
  assets: ['detection.onnx', 'structure.onnx'].map((file) => ({
    file,
    url: `https://example.invalid/${name}/${file}`,
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex')
  }))
})
const prepare = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'local-models-'))
  roots.push(root)
  return root
}
const installFile = vi.fn(async (_url: string, path: string): Promise<string> => {
  await writeFile(path, content)
  return path
})
const waitForIdle = async (owner: ReturnType<typeof createLocalModelOwner>): Promise<void> => {
  await vi.waitFor(async () =>
    expect((await owner.getSnapshot()).availability).not.toBe('installing')
  )
}
const seed = async (root: string, name = 'v1'): Promise<void> => {
  const folder = join(root, 'models', 'pdf-tables', 'revisions', name)
  await mkdir(folder, { recursive: true })
  for (const asset of revision(name).assets) await writeFile(join(folder, asset.file), content)
  await writeFile(
    join(root, 'models', 'pdf-tables', 'active.json'),
    JSON.stringify({ schemaVersion: 1, revision: name, installedAt: 1 })
  )
}

describe('local model use leases', () => {
  it('does not overwrite a published update with a late old-revision verification failure', async () => {
    const root = await prepare()
    await seed(root)
    let finishDownload!: () => void
    const download = vi.fn(async (_url: string, path: string) => {
      if (download.mock.calls.length === 1)
        await new Promise<void>((resolve) => {
          finishDownload = resolve
        })
      await writeFile(path, content)
      return path
    })
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v2'), revision('v1')],
      download
    })
    await owner.install()
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
    let finishRead!: () => void
    let sawRead!: () => void
    const readBlocked = new Promise<void>((resolve) => {
      finishRead = resolve
    })
    const readStarted = new Promise<void>((resolve) => {
      sawRead = resolve
    })
    const readReceipt = durableJson.readFileWithinLimit
    const spy = vi
      .spyOn(durableJson, 'readFileWithinLimit')
      .mockImplementationOnce(async (...args) => {
        const receipt = await readReceipt(...args)
        sawRead()
        await readBlocked
        return receipt
      })
    try {
      const rejected = expect(owner.acquireUse()).rejects.toBeInstanceOf(DownloadChecksumError)
      await readStarted
      finishDownload()
      await waitForIdle(owner)
      await writeFile(
        join(root, 'models', 'pdf-tables', 'revisions', 'v1', 'detection.onnx'),
        'broken'
      )
      finishRead()
      await rejected
      expect(await owner.getSnapshot()).toMatchObject({
        availability: 'ready',
        installedRevision: 'v2',
        inUse: false,
        error: undefined
      })
      const current = await owner.acquireUse()
      expect(current.revision).toBe('v2')
      current.release()
    } finally {
      finishRead()
      finishDownload()
      spy.mockRestore()
      await owner.close()
    }
  })
  it('preserves download progress and cancellation when an old revision fails use verification', async () => {
    const root = await prepare()
    await seed(root)
    let finishDownload!: () => void
    const download = vi.fn(async (_url: string, path: string) => {
      await new Promise<void>((resolve) => {
        finishDownload = resolve
      })
      await writeFile(path, content)
      return path
    })
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v2'), revision('v1')],
      download
    })
    await owner.install()
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
    await writeFile(
      join(root, 'models', 'pdf-tables', 'revisions', 'v1', 'detection.onnx'),
      'broken'
    )
    await expect(owner.acquireUse()).rejects.toBeInstanceOf(DownloadChecksumError)
    expect(await owner.getSnapshot()).toMatchObject({
      availability: 'installing',
      inUse: false,
      error: undefined
    })
    const cancelling = owner.cancel()
    finishDownload()
    await cancelling
    expect((await owner.getSnapshot()).availability).not.toBe('installing')
    await owner.close()
    await waitForDataRootWriters()
  })
  it('refuses new use after same-revision repair admission', async () => {
    const root = await prepare()
    await seed(root)
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v1')],
      download: installFile
    })
    await owner.getSnapshot()
    await writeFile(
      join(root, 'models', 'pdf-tables', 'revisions', 'v1', 'detection.onnx'),
      'broken'
    )
    // The snapshot still names v1 when repair starts. Its files may be replaced one by one.
    expect((await owner.install()).installedRevision).toBe('v1')
    await expect(owner.acquireUse()).rejects.toThrow('management is in progress')
    await waitForIdle(owner)
    const use = await owner.acquireUse()
    expect(await readFile(use.assets[0].path)).toEqual(content)
    use.release()
    await owner.close()
  })
  it('reserves use before verification and prevents removal until the last release', async () => {
    const root = await prepare()
    await seed(root)
    const owner = createLocalModelOwner({ dataRoot: () => root, revisions: [revision('v1')] })
    await owner.getSnapshot()
    const acquiring = owner.acquireUse()
    expect(await owner.remove()).toMatchObject({ inUse: true, hasFiles: true })
    const first = await acquiring
    const second = await owner.acquireUse()
    expect(first.revision).toBe('v1')
    expect(first.assets).toEqual(
      revision('v1').assets.map((asset) => ({
        file: asset.file,
        size: asset.size,
        sha256: asset.sha256,
        path: join(root, 'models', 'pdf-tables', 'revisions', 'v1', asset.file)
      }))
    )
    first.release()
    first.release()
    expect((await owner.remove()).inUse).toBe(true)
    expect(await readFile(second.assets[0].path)).toEqual(content)
    second.release()
    expect(await owner.remove()).toMatchObject({ inUse: false, hasFiles: false })
    await owner.close()
  })

  it('refuses a use racing after removal admission and releases failed missing-model uses', async () => {
    const root = await prepare()
    await seed(root)
    const owner = createLocalModelOwner({ dataRoot: () => root, revisions: [revision('v1')] })
    await owner.getSnapshot()
    const removing = owner.remove()
    await expect(owner.acquireUse()).rejects.toThrow('management is in progress')
    await removing
    await expect(owner.acquireUse()).rejects.toThrow('not installed')
    expect((await owner.getSnapshot()).inUse).toBe(false)
    await owner.close()
    await waitForDataRootWriters()
  })

  it('rechecks integrity for every use and never repairs an actively used revision', async () => {
    const root = await prepare()
    await seed(root)
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v1')],
      download: installFile
    })
    const use = await owner.acquireUse()
    await writeFile(use.assets[0].path, 'broken')
    await expect(owner.acquireUse()).rejects.toBeInstanceOf(DownloadChecksumError)
    expect((await owner.install()).inUse).toBe(true)
    expect(installFile).not.toHaveBeenCalled()
    expect(await readFile(use.assets[0].path, 'utf8')).toBe('broken')
    use.release()
    await owner.install()
    await waitForIdle(owner)
    const repaired = await owner.acquireUse()
    expect(await readFile(repaired.assets[0].path)).toEqual(content)
    repaired.release()
    await owner.close()
  })

  it('pins old uses through an update while new uses follow the published revision', async () => {
    const root = await prepare()
    await seed(root)
    let finishDownload!: () => void
    const download = vi.fn(async (_url: string, path: string) => {
      if (download.mock.calls.length === 1)
        await new Promise<void>((resolve) => {
          finishDownload = resolve
        })
      await writeFile(path, content)
      return path
    })
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v2'), revision('v1')],
      download
    })
    const old = await owner.acquireUse()
    await owner.install()
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
    const during = await owner.acquireUse()
    expect(during.revision).toBe('v1')
    finishDownload()
    await waitForIdle(owner)
    const latest = await owner.acquireUse()
    expect(latest.revision).toBe('v2')
    for (const use of [old, during]) {
      expect(use.revision).toBe('v1')
      expect(await readFile(use.assets[0].path)).toEqual(content)
    }
    expect((await owner.remove()).inUse).toBe(true)
    for (const use of [old, during, latest]) use.release()
    await owner.close()
  })

  it('rejects migration starting between initialization and use without leaking a writer', async () => {
    const root = await prepare()
    await seed(root)
    let acquisitions = 0
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v1')],
      acquireWriter: () => {
        acquisitions++
        const release = acquireDataRootWriter()
        return () => {
          release()
          if (acquisitions === 1) beginMigration()
        }
      }
    })
    try {
      await expect(owner.acquireUse()).rejects.toThrow('moving your data')
      expect(acquisitions).toBe(2)
      expect((await owner.getSnapshot()).inUse).toBe(false)
      await waitForDataRootWriters()
    } finally {
      endMigration()
      await owner.close()
    }
  })

  it('keeps one writer through use, cancellation of management and shutdown', async () => {
    const root = await prepare()
    await seed(root)
    let acquisitions = 0
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v1')],
      acquireWriter: () => {
        acquisitions++
        return acquireDataRootWriter()
      }
    })
    const use = await owner.acquireUse()
    beginMigration()
    try {
      let drained = false
      const drain = waitForDataRootWriters().then(() => {
        drained = true
      })
      await owner.cancel()
      expect((await owner.getSnapshot()).inUse).toBe(true)
      let closed = false
      const closing = owner.close().then(() => {
        closed = true
      })
      await expect(owner.acquireUse()).rejects.toThrow('closed')
      expect(closed).toBe(false)
      expect(drained).toBe(false)
      expect(acquisitions).toBe(2)
      expect(await readFile(use.assets[0].path)).toEqual(content)
      use.release()
      await Promise.all([closing, drain])
      expect(closed).toBe(true)
      expect(drained).toBe(true)
    } finally {
      use.release()
      endMigration()
      await owner.close()
    }
  })

  it('joins a use still verifying when close begins', async () => {
    const root = await prepare()
    await seed(root)
    const owner = createLocalModelOwner({ dataRoot: () => root, revisions: [revision('v1')] })
    await owner.getSnapshot()
    const acquiring = owner.acquireUse()
    const rejected = expect(acquiring).rejects.toThrow('closed')
    await Promise.resolve()
    expect((await owner.getSnapshot()).inUse).toBe(true)
    await owner.close()
    await rejected
    expect((await owner.getSnapshot()).inUse).toBe(false)
    await waitForDataRootWriters()
  })

  it('retains use protection after the runtime advances past a timed-out worker disposer', async () => {
    const root = await prepare()
    await seed(root)
    const owner = createLocalModelOwner({ dataRoot: () => root, revisions: [revision('v1')] })
    const use = await owner.acquireUse()
    let finishWorker!: () => void
    const stopped = new Promise<void>((resolve) => {
      finishWorker = resolve
    })
    const closing = vi.fn(() => owner.close())
    const runtime = await composeApplicationRuntime(async (modules) => {
      await modules.add({}, () => ({
        name: 'models',
        capability: undefined,
        dispose: closing,
        disposeTimeoutMs: 10
      }))
      await modules.add({}, () => ({
        name: 'structure',
        capability: undefined,
        dispose: () => stopped.then(() => use.release()),
        disposeTimeoutMs: 10
      }))
    })
    await expect(runtime.dispose()).rejects.toThrow('disposal failed')
    expect(closing).toHaveBeenCalledOnce()
    expect((await owner.getSnapshot()).inUse).toBe(true)
    await expect(owner.acquireUse()).rejects.toThrow('closed')
    let drained = false
    const drain = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(await readFile(use.assets[0].path)).toEqual(content)
    finishWorker()
    await Promise.all([owner.close(), drain])
    expect((await owner.getSnapshot()).inUse).toBe(false)
  })
})

describe('local model lifecycle', () => {
  it('reports package-wide progress and live transfer speed across model files', async () => {
    const root = await prepare()
    const seen: DownloadProgress[] = []
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v1')],
      acquireWriter: () => () => undefined,
      download: async (_url, path, options = {}) => {
        for (const phase of ['reconnecting', 'downloading'] as const) {
          options.onProgress?.({
            phase,
            transferred: 6,
            total: content.length,
            percent: 46,
            bytesPerSecond: phase === 'reconnecting' ? 0 : 2,
            etaSeconds: 4,
            attempt: 2
          })
          seen.push((await owner.getSnapshot()).downloadProgress!)
        }
        await writeFile(path, content)
        return path
      }
    })
    await owner.install()
    await waitForIdle(owner)
    expect(seen).toEqual([
      {
        phase: 'reconnecting',
        transferred: 6,
        total: 26,
        percent: 23,
        bytesPerSecond: 0,
        etaSeconds: undefined,
        attempt: 2
      },
      {
        phase: 'downloading',
        transferred: 6,
        total: 26,
        percent: 23,
        bytesPerSecond: 2,
        etaSeconds: 10,
        attempt: 2
      },
      {
        phase: 'reconnecting',
        transferred: 19,
        total: 26,
        percent: 73,
        bytesPerSecond: 0,
        etaSeconds: undefined,
        attempt: 2
      },
      {
        phase: 'downloading',
        transferred: 19,
        total: 26,
        percent: 73,
        bytesPerSecond: 2,
        etaSeconds: 4,
        attempt: 2
      }
    ])
    expect((await owner.getSnapshot()).downloadProgress).toBeUndefined()
    await owner.close()
  })
  it('blocks an installation racing with application shutdown', async () => {
    const root = await prepare()
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v1')],
      download: installFile,
      acquireWriter: () => () => undefined
    })
    const installing = owner.install()
    await owner.close()
    await installing
    expect(installFile).not.toHaveBeenCalled()
    expect((await owner.install()).availability).not.toBe('installing')
  })
  it('publishes only complete verified weights and restores them after restart', async () => {
    const root = await prepare()
    const deps = {
      dataRoot: () => root,
      revisions: [revision('v1')],
      download: installFile,
      acquireWriter: () => () => undefined
    }
    const owner = createLocalModelOwner(deps)
    expect((await owner.getSnapshot()).availability).toBe('notInstalled')
    expect((await owner.install()).availability).toBe('installing')
    await waitForIdle(owner)
    expect(await owner.getSnapshot()).toMatchObject({
      availability: 'ready',
      installedRevision: 'v1',
      installedBytes: content.length * 2
    })
    expect(await createLocalModelOwner(deps).getSnapshot()).toMatchObject({
      availability: 'ready',
      installedRevision: 'v1'
    })
  })

  it('deduplicates downloads and joins cancellation before releasing the writer', async () => {
    const root = await prepare()
    let writers = 0
    const download = vi.fn(async (_url, path, options) => {
      await writeFile(path + '.part', 'partial')
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      )
      expect(writers).toBe(1)
      throw new Error('cancelled')
    })
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v1')],
      download,
      acquireWriter: () => {
        writers++
        return () => {
          writers--
        }
      }
    })
    await Promise.all([owner.install(), owner.install()])
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect((await owner.cancel()).availability).toBe('notInstalled')
    expect(writers).toBe(0)
    expect(
      await readFile(join(root, 'models/pdf-tables/staging/v1/detection.onnx.part'), 'utf8')
    ).toBe('partial')
    expect((await owner.getSnapshot()).hasFiles).toBe(true)
    const restarted = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v1')],
      acquireWriter: () => () => undefined
    })
    expect((await restarted.getSnapshot()).hasFiles).toBe(true)
    expect((await restarted.remove()).hasFiles).toBe(false)
    await expect(
      readFile(join(root, 'models/pdf-tables/staging/v1/detection.onnx.part'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('holds the migration gate until an active download has joined shutdown', async () => {
    const root = await prepare()
    let finishDownload!: () => void
    let sawAbort = false
    const download = vi.fn(async (_url, path, options) => {
      await new Promise<void>((resolve) => {
        finishDownload = resolve
        options?.signal?.addEventListener(
          'abort',
          () => {
            sawAbort = true
          },
          { once: true }
        )
      })
      return path
    })
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v1')],
      download
    })
    try {
      await owner.install()
      await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
      beginMigration()
      let drained = false
      const drain = waitForDataRootWriters().then(() => {
        drained = true
      })
      let closed = false
      const closing = owner.close().then(() => {
        closed = true
      })
      await Promise.resolve()
      expect(sawAbort).toBe(true)
      expect(drained).toBe(false)
      expect(closed).toBe(false)
      finishDownload()
      await Promise.all([closing, drain])
      expect(drained).toBe(true)
      await expect(readFile(join(root, 'models/pdf-tables/active.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    } finally {
      finishDownload?.()
      await owner.close()
      endMigration()
    }
  })

  it('does not publish corrupt assets and can retry the failed installation', async () => {
    const root = await prepare()
    let corrupt = true
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v1')],
      acquireWriter: () => () => undefined,
      download: async (_url, path) => {
        await writeFile(path, corrupt ? 'corrupt' : content)
        return path
      }
    })
    await owner.install()
    await waitForIdle(owner)
    expect(await owner.getSnapshot()).toMatchObject({
      availability: 'error',
      error: 'integrity',
      installedBytes: 0
    })
    await expect(readFile(join(root, 'models/pdf-tables/active.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    corrupt = false
    await owner.install()
    await waitForIdle(owner)
    expect((await owner.getSnapshot()).availability).toBe('ready')
  })

  it('keeps the installed revision usable when an update fails', async () => {
    const root = await prepare()
    const shared = { dataRoot: () => root, acquireWriter: () => () => undefined }
    const first = createLocalModelOwner({
      ...shared,
      revisions: [revision('v1')],
      download: installFile
    })
    await first.install()
    await waitForIdle(first)
    const next = createLocalModelOwner({
      ...shared,
      revisions: [revision('v2'), revision('v1')],
      download: async () => {
        throw new DownloadChecksumError()
      }
    })
    expect((await next.getSnapshot()).updateAvailable).toBe(true)
    await next.install()
    await waitForIdle(next)
    expect(await next.getSnapshot()).toMatchObject({
      availability: 'ready',
      installedRevision: 'v1',
      error: 'integrity',
      updateAvailable: true
    })
    expect(
      JSON.parse(await readFile(join(root, 'models/pdf-tables/active.json'), 'utf8')).revision
    ).toBe('v1')
  })

  it('removes only known model files and preserves documents, results and unknown revisions', async () => {
    const root = await prepare()
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v1')],
      download: installFile,
      acquireWriter: () => () => undefined
    })
    await owner.install()
    await waitForIdle(owner)
    await writeFile(join(root, 'source.pdf'), 'source')
    await writeFile(join(root, 'results.json'), 'results')
    await mkdir(join(root, 'models/pdf-tables/revisions/future'))
    await writeFile(join(root, 'models/pdf-tables/revisions/future/model.onnx'), 'future')
    expect((await owner.remove()).availability).toBe('notInstalled')
    expect(await readFile(join(root, 'source.pdf'), 'utf8')).toBe('source')
    expect(await readFile(join(root, 'results.json'), 'utf8')).toBe('results')
    expect(
      await readFile(join(root, 'models/pdf-tables/revisions/future/model.onnx'), 'utf8')
    ).toBe('future')
  })

  it('preserves a newer receipt and refuses install and removal', async () => {
    const root = await prepare()
    await mkdir(join(root, 'models/pdf-tables'), { recursive: true })
    const path = join(root, 'models/pdf-tables/active.json')
    const receipt = JSON.stringify({ schemaVersion: 2, revision: 'future' })
    await writeFile(path, receipt)
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      acquireWriter: () => () => undefined
    })
    expect((await owner.getSnapshot()).error).toBe('incompatible')
    await owner.install()
    await owner.remove()
    expect(await readFile(path, 'utf8')).toBe(receipt)
  })

  it('keeps malformed receipts classified as storage failures without mutating model files', async () => {
    const root = await prepare()
    const shared = {
      dataRoot: () => root,
      revisions: [revision('v1')],
      acquireWriter: () => () => undefined
    }
    const installed = createLocalModelOwner({ ...shared, download: installFile })
    await installed.install()
    await waitForIdle(installed)
    await installed.close()
    const receiptPath = join(root, 'models/pdf-tables/active.json')
    const receipt = '{"schemaVersion":1,"revision":'
    await writeFile(receiptPath, receipt)
    const download = vi.fn(async () => {
      throw new Error('Unexpected download for a malformed receipt')
    })
    const owner = createLocalModelOwner({ ...shared, download })

    for (const action of [owner.getSnapshot, owner.install, owner.remove]) {
      await action()
      await waitForIdle(owner)
      expect(await owner.getSnapshot()).toMatchObject({ availability: 'error', error: 'storage' })
      expect(await readFile(receiptPath, 'utf8')).toBe(receipt)
      for (const asset of shared.revisions[0].assets) {
        expect(await readFile(join(root, 'models/pdf-tables/revisions/v1', asset.file))).toEqual(
          content
        )
      }
    }
    expect(download).not.toHaveBeenCalled()
    await owner.close()
  })

  it('does not classify a downloader SyntaxError as a receipt storage failure', async () => {
    const root = await prepare()
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      revisions: [revision('v1')],
      acquireWriter: () => () => undefined,
      download: async () => {
        throw new SyntaxError('Invalid network response')
      }
    })
    await owner.install()
    await waitForIdle(owner)
    expect(await owner.getSnapshot()).toMatchObject({ availability: 'error', error: 'download' })
    await owner.close()
  })

  it('does not follow a model directory symlink', async () => {
    const root = await prepare()
    const outside = await prepare()
    await symlink(outside, join(root, 'models'), process.platform === 'win32' ? 'junction' : 'dir')
    const download = vi.fn(installFile)
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      download,
      acquireWriter: () => () => undefined
    })
    await owner.install()
    await waitForIdle(owner)
    expect((await owner.getSnapshot()).error).toBe('storage')
    expect(download).not.toHaveBeenCalled()
  })

  it('does not start a download when the data-root writer gate is closed', async () => {
    const root = await prepare()
    const download = vi.fn(installFile)
    const owner = createLocalModelOwner({
      dataRoot: () => root,
      download,
      acquireWriter: () => {
        throw new Error('migration pending')
      }
    })
    expect((await owner.install()).error).toBe('storage')
    expect(download).not.toHaveBeenCalled()
  })
})
