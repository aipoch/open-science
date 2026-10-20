import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createPackArchive, extractPackArchive } from './pack-archive'

const roots: string[] = []

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'os-pack-archive-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('pack archive codec', () => {
  it('round-trips a pack without invoking host tar or zstd binaries', async () => {
    const root = await makeRoot()
    const source = join(root, 'source')
    const extracted = join(root, 'extracted')
    const archive = join(root, 'python-3.12.tar.zst')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'python-3.12.lock'), '@EXPLICIT\n')
    await mkdir(join(source, 'nested'))
    await writeFile(join(source, 'nested', 'package.conda'), 'package')

    await createPackArchive(source, archive)
    await extractPackArchive(archive, extracted)

    expect(await readFile(join(extracted, 'python-3.12.lock'), 'utf8')).toBe('@EXPLICIT\n')
    expect(await readFile(join(extracted, 'nested', 'package.conda'), 'utf8')).toBe('package')
  })

  it.skipIf(process.platform === 'win32')('rejects symlink members during extraction', async () => {
    const root = await makeRoot()
    const source = join(root, 'source')
    const archive = join(root, 'unsafe.tar.zst')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'package.conda'), 'package')
    await symlink('/tmp/outside-runtime-pack', join(source, 'escape'))
    await createPackArchive(source, archive)

    await expect(extractPackArchive(archive, join(root, 'extracted'))).rejects.toThrow(/unsafe/)
  })

  it('rejects (does not hang) on a corrupt archive, tearing the stream chain down', async () => {
    const root = await makeRoot()
    const archive = join(root, 'python-3.12.tar.zst')
    // Not a valid zstd stream: the decompressor errors, and pipeline must propagate the failure and
    // destroy the whole chain (release the file handle) rather than hang or mask the error.
    await writeFile(archive, Buffer.from('this is not a zstd frame'))

    await expect(extractPackArchive(archive, join(root, 'extracted'))).rejects.toThrow()
  })
})
