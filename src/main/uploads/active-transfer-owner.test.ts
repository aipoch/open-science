import { execFileSync } from 'node:child_process'
import {
  createReadStream,
  fstatSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: vi.fn(actual.rm)
  }
})

import { ActiveTransferOwner } from './active-transfer-owner'
import { STAGING_UPLOAD_SESSION_ID, getSessionUploadDir } from './storage-helpers'

const actualFsPromises =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

let storageRoot: string | undefined

afterEach(async () => {
  vi.mocked(rm).mockReset().mockImplementation(actualFsPromises.rm)
  if (storageRoot) await actualFsPromises.rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('ActiveTransferOwner staging initialization', () => {
  it.each(['same size', 'grow', 'shrink', 'restored mtime'])(
    'rejects a source rewrite (%s) during local import and removes staging',
    async (change) => {
      storageRoot = await mkdtemp(join(tmpdir(), 'open-science-active-transfer-'))
      const sourcePath = join(storageRoot, 'changing.csv')
      await writeFile(sourcePath, 'A'.repeat(32))
      const owner = new ActiveTransferOwner(storageRoot, {
        createLocalReadStream: (path, options) =>
          createReadStream(path, { ...options, highWaterMark: 1 })
      })
      const before = statSync(sourcePath)
      let changed = false
      const result = await owner
        .stageLocalFile(
          { transferId: 'changing-source', sourcePath, name: 'changing.csv', size: 32 },
          () => {
            if (changed) return
            changed = true
            writeFileSync(
              sourcePath,
              'B'.repeat(change === 'grow' ? 40 : change === 'shrink' ? 16 : 32)
            )
            if (change === 'restored mtime') utimesSync(sourcePath, before.atime, before.mtime)
          }
        )
        .then(
          async (attachment) => ({ content: await readFile(attachment.path, 'utf8') }),
          (error: Error) => ({ error: error.message })
        )
      expect(result).toEqual({
        error: 'Upload source changed while it was being staged: changing.csv'
      })
      expect(await readdir(getSessionUploadDir(storageRoot, STAGING_UPLOAD_SESSION_ID))).toEqual([])
      expect(await readdir(getSessionUploadDir(storageRoot, PENDING_UPLOAD_SESSION_ID))).toEqual([])
    }
  )

  it('reads the opened source instead of a replacement pathname and closes its handle', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-active-transfer-'))
    const sourcePath = join(storageRoot, 'replaced.csv')
    await writeFile(sourcePath, 'A'.repeat(32))
    let sourceFd = -1
    const owner = new ActiveTransferOwner(storageRoot, {
      createLocalReadStream: (path, options) => {
        sourceFd = options.fd.fd
        renameSync(sourcePath, `${sourcePath}-held`)
        writeFileSync(sourcePath, 'B'.repeat(32))
        return createReadStream(path, options)
      }
    })
    const result = await owner
      .stageLocalFile({
        transferId: 'replaced-source',
        sourcePath,
        name: 'replaced.csv',
        size: 32
      })
      .then(
        async (attachment) => ({ content: await readFile(attachment.path, 'utf8') }),
        (error: Error) => ({ error: error.message })
      )
    // A rename may update ctime. Either reject that observation or keep the complete opened file;
    // the replacement's bytes must never be admitted as the previously validated source.
    expect([
      { content: 'A'.repeat(32) },
      { error: 'Upload source changed while it was being staged: replaced.csv' }
    ]).toContainEqual(result)
    expect(() => fstatSync(sourceFd)).toThrow(expect.objectContaining({ code: 'EBADF' }))
  })

  it('closes the owned handle when the source stream fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-active-transfer-'))
    const sourcePath = join(storageRoot, 'unreadable.csv')
    await writeFile(sourcePath, 'A'.repeat(32))
    let source: import('node:fs/promises').FileHandle | undefined
    const owner = new ActiveTransferOwner(storageRoot, {
      createLocalReadStream: (path, options) => {
        source = options.fd
        const stream = createReadStream(path, { ...options, highWaterMark: 1 })
        stream.once('data', () => stream.destroy(new Error('source read failed')))
        return stream
      }
    })
    await expect(
      owner.stageLocalFile({
        transferId: 'unreadable-source',
        sourcePath,
        name: 'unreadable.csv',
        size: 32
      })
    ).rejects.toThrow('source read failed')
    expect(source?.fd).toBe(-1)
    expect(await readdir(getSessionUploadDir(storageRoot, STAGING_UPLOAD_SESSION_ID))).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO without waiting for a writer',
    async () => {
      storageRoot = await mkdtemp(join(tmpdir(), 'open-science-active-transfer-'))
      const sourcePath = join(storageRoot, 'named-pipe')
      execFileSync('mkfifo', [sourcePath])
      const owner = new ActiveTransferOwner(storageRoot)
      let neededWriter = false
      let writer: Promise<Awaited<ReturnType<typeof open>>> | undefined
      // Release an accidentally blocking open so a regression cannot strand a filesystem worker.
      const timer = setTimeout(() => {
        neededWriter = true
        writer = open(sourcePath, 'r+')
      }, 5_000)
      try {
        await expect(
          owner.stageLocalFile({
            transferId: 'fifo-source',
            sourcePath,
            name: 'named-pipe',
            size: 0
          })
        ).rejects.toThrow('Upload source is not a file')
        expect(neededWriter).toBe(false)
      } finally {
        clearTimeout(timer)
        await (await writer)?.close()
      }
    }
  )

  it('accepts an unchanged empty local file', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-active-transfer-'))
    const sourcePath = join(storageRoot, 'empty.csv')
    await writeFile(sourcePath, '')
    const owner = new ActiveTransferOwner(storageRoot)
    const attachment = await owner.stageLocalFile({
      transferId: 'empty-source',
      sourcePath,
      name: 'empty.csv',
      size: 0
    })
    expect(await readFile(attachment.path, 'utf8')).toBe('')
  })

  it('retries initialization after a transient filesystem failure', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-active-transfer-'))
    const owner = new ActiveTransferOwner(storageRoot)
    const transientFailure = new Error('transient staging cleanup failure')
    vi.mocked(rm).mockRejectedValueOnce(transientFailure)

    const request = { transferId: 'retry-transfer', name: 'data.csv', size: 1 }

    await expect(owner.beginTransfer(request)).rejects.toBe(transientFailure)
    await expect(owner.beginTransfer(request)).resolves.toMatchObject({
      transferId: request.transferId,
      receivedBytes: 0,
      totalBytes: request.size
    })
    expect(rm).toHaveBeenNthCalledWith(
      1,
      getSessionUploadDir(storageRoot, STAGING_UPLOAD_SESSION_ID),
      { recursive: true, force: true }
    )
    expect(rm).toHaveBeenNthCalledWith(
      2,
      getSessionUploadDir(storageRoot, STAGING_UPLOAD_SESSION_ID),
      { recursive: true, force: true }
    )
    expect(rm).toHaveBeenNthCalledWith(
      3,
      getSessionUploadDir(storageRoot, PENDING_UPLOAD_SESSION_ID),
      { recursive: true, force: true }
    )

    await owner.abortTransfer({ transferId: request.transferId })
  })
})
