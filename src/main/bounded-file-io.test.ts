import { mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  copyFileWithinBudget,
  copyOpenFileWithinBudget,
  readFilePageAndDigest,
  readVerifiedFilePage,
  writeInlineWithinBudget
} from './bounded-file-io'
import { ResourceBudgetExceededError } from './resource-budget'

let root: string | undefined

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('bounded file IO', () => {
  it('stops a streaming copy at the file limit', async () => {
    root = await mkdtemp(join(tmpdir(), 'bounded-file-io-'))
    const source = join(root, 'source')
    await writeFile(source, '0123456789')

    await expect(copyFileWithinBudget(source, join(root, 'target'), 5)).rejects.toBeInstanceOf(
      ResourceBudgetExceededError
    )
    await expect(readFile(join(root, 'target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes a partial copy when the caller aborts', async () => {
    root = await mkdtemp(join(tmpdir(), 'bounded-file-io-'))
    const source = join(root, 'source')
    const target = join(root, 'target')
    await writeFile(source, '0123456789')
    const controller = new AbortController()
    controller.abort()

    await expect(copyFileWithinBudget(source, target, 10, controller.signal)).rejects.toMatchObject(
      {
        name: 'AbortError'
      }
    )
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not remove a pre-existing target when exclusive creation fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'bounded-file-io-'))
    const source = join(root, 'source')
    const target = join(root, 'target')
    await writeFile(source, 'replacement')
    await writeFile(target, 'existing')

    await expect(copyFileWithinBudget(source, target, 32)).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(readFile(target, 'utf8')).resolves.toBe('existing')
  })

  it('leaves an open source handle owned by the caller after a budget failure', async () => {
    root = await mkdtemp(join(tmpdir(), 'bounded-file-io-'))
    const source = join(root, 'source')
    const target = join(root, 'target')
    await writeFile(source, '0123456789')
    const sourceHandle = await open(source, 'r')

    try {
      await expect(copyOpenFileWithinBudget(sourceHandle, target, 5)).rejects.toBeInstanceOf(
        ResourceBudgetExceededError
      )
      await expect(sourceHandle.stat()).resolves.toMatchObject({ size: 10 })
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await sourceHandle.close()
    }
  })

  it('leaves an open source handle owned by the caller after cancellation', async () => {
    root = await mkdtemp(join(tmpdir(), 'bounded-file-io-'))
    const source = join(root, 'source')
    const target = join(root, 'target')
    await writeFile(source, '0123456789')
    const sourceHandle = await open(source, 'r')
    const controller = new AbortController()
    controller.abort()

    try {
      await expect(
        copyOpenFileWithinBudget(sourceHandle, target, 10, controller.signal)
      ).rejects.toMatchObject({ name: 'AbortError' })
      await expect(sourceHandle.stat()).resolves.toMatchObject({ size: 10 })
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await sourceHandle.close()
    }
  })

  it('preserves an existing target when copying from an open source handle', async () => {
    root = await mkdtemp(join(tmpdir(), 'bounded-file-io-'))
    const source = join(root, 'source')
    const target = join(root, 'target')
    await writeFile(source, 'replacement')
    await writeFile(target, 'existing')
    const sourceHandle = await open(source, 'r')

    try {
      await expect(copyOpenFileWithinBudget(sourceHandle, target, 32)).rejects.toMatchObject({
        code: 'EEXIST'
      })
      await expect(sourceHandle.stat()).resolves.toMatchObject({ size: 11 })
      await expect(readFile(target, 'utf8')).resolves.toBe('existing')
    } finally {
      await sourceHandle.close()
    }
  })

  it('writes UTF-8 inline content in chunks without splitting surrogate pairs', async () => {
    root = await mkdtemp(join(tmpdir(), 'bounded-file-io-'))
    const target = join(root, 'target')
    const content = `${'a'.repeat(16 * 1024 - 1)}😀tail`

    const digest = await writeInlineWithinBudget(target, content, 'utf8', 32 * 1024)

    expect(await readFile(target, 'utf8')).toBe(content)
    expect(digest.sizeBytes).toBe(Buffer.byteLength(content))
  })

  it('decodes multiline base64 across chunk boundaries', async () => {
    root = await mkdtemp(join(tmpdir(), 'bounded-file-io-'))
    const target = join(root, 'target')
    const bytes = Buffer.from('x'.repeat(128 * 1024))
    const encoded = bytes.toString('base64').replace(/.{73}/gu, (line) => `${line}\n`)

    const digest = await writeInlineWithinBudget(target, encoded, 'base64', bytes.byteLength)

    expect(await readFile(target)).toEqual(bytes)
    expect(digest.sizeBytes).toBe(bytes.byteLength)
  })

  it('hashes the whole file while retaining only the requested prefix', async () => {
    root = await mkdtemp(join(tmpdir(), 'bounded-file-io-'))
    const source = join(root, 'source')
    await writeFile(source, 'abcdefghij')

    await expect(readFilePageAndDigest(source, 2, 4)).resolves.toMatchObject({
      page: Buffer.from('cdef'),
      sizeBytes: 10,
      offset: 2,
      returnedBytes: 4,
      truncated: true
    })
  })

  it('reads bounded pages only while the verified file observation remains stable', async () => {
    root = await mkdtemp(join(tmpdir(), 'bounded-file-io-'))
    const source = join(root, 'source')
    const replacement = join(root, 'replacement')
    const displaced = join(root, 'displaced')
    await writeFile(source, 'abcdefghij')
    const verified = await readFilePageAndDigest(source, 0, 0)

    await expect(readVerifiedFilePage(source, 4, 3, verified.observation)).resolves.toMatchObject({
      page: Buffer.from('efg'),
      offset: 4,
      returnedBytes: 3,
      truncated: true
    })

    await writeFile(replacement, '0123456789')
    await rename(source, displaced)
    await rename(replacement, source)
    await expect(readVerifiedFilePage(source, 4, 3, verified.observation)).rejects.toThrow(
      /changed since verification/u
    )
  })
})
