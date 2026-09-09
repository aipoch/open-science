import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, lstat, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { publishNoReplace, removeAnchoredFile } from './atomic-no-replace-publisher'

const require = createRequire(import.meta.url)
const nativeBindingAvailable = (() => {
  try {
    require('@aipoch/safe-file-publisher-native')
    return true
  } catch {
    return false
  }
})()

let cleanupRoot: string | undefined

afterEach(async () => {
  if (cleanupRoot) await rm(cleanupRoot, { recursive: true, force: true })
  cleanupRoot = undefined
})

describe.skipIf(!nativeBindingAvailable)('atomic no-replace publisher', () => {
  it('reports publication capabilities for a local storage root', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const binding = require('@aipoch/safe-file-publisher-native') as {
      inspectPath: (path: string) => { isRemote: boolean; supportsHardLinks: boolean }
    }

    expect(binding.inspectPath(cleanupRoot)).toEqual({
      isRemote: false,
      supportsHardLinks: true
    })
  })

  it('publishes within an anchored parent without replacing an existing destination', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const sourcePath = join(cleanupRoot, 'source.tmp')
    const destinationPath = join(cleanupRoot, 'content')
    await writeFile(sourcePath, 'verified')

    publishNoReplace(cleanupRoot, cleanupRoot, basename(sourcePath), basename(destinationPath))

    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('verified')
    await expect(readFile(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(sourcePath, 'next')
    expect(() =>
      publishNoReplace(cleanupRoot!, cleanupRoot!, basename(sourcePath), basename(destinationPath))
    ).toThrow(expect.objectContaining({ code: 'EEXIST' }))
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('verified')
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('next')
  })

  it('rejects a symlinked or junction publication parent', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-publisher-'))
    const outsideParent = join(cleanupRoot, 'outside')
    const linkedParent = join(cleanupRoot, 'linked')
    await mkdir(outsideParent)
    await writeFile(join(outsideParent, 'source.tmp'), 'verified')
    await symlink(outsideParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => publishNoReplace(cleanupRoot!, linkedParent, 'source.tmp', 'content')).toThrow()
    await expect(readFile(join(outsideParent, 'content'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

// These exercise the real native mutation boundary on each portable CI platform.
describe.skipIf(!nativeBindingAvailable)('anchored publication removal', () => {
  it('removes only the named file and rejects a changed parent identity', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-removal-'))
    const parent = join(cleanupRoot, 'content')
    await mkdir(parent)
    const identity = await lstat(parent, { bigint: true })
    await writeFile(join(parent, 'attempt.tmp'), 'interrupted')
    await writeFile(join(parent, 'published'), 'keep')
    removeAnchoredFile(cleanupRoot, 'content', 'attempt.tmp', identity)
    await expect(readFile(join(parent, 'attempt.tmp'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(parent, 'published'), 'utf8')).toBe('keep')
    await rename(parent, `${parent}-held`)
    await mkdir(parent)
    await writeFile(join(parent, 'attempt.tmp'), 'replacement')
    expect(() => removeAnchoredFile(cleanupRoot!, 'content', 'attempt.tmp', identity)).toThrow(
      expect.objectContaining({ code: 'ESTALE' })
    )
    expect(await readFile(join(parent, 'attempt.tmp'), 'utf8')).toBe('replacement')
  })

  it.each(['root', 'ancestor', 'parent'] as const)(
    'refuses a linked %s directory',
    async (level) => {
      cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-removal-'))
      const root = join(cleanupRoot, 'root')
      const parent = join(root, 'content', 'blobs')
      await mkdir(parent, { recursive: true })
      await writeFile(join(parent, 'attempt.tmp'), 'keep')
      const identity = await lstat(parent, { bigint: true })
      const target = level === 'root' ? root : level === 'ancestor' ? join(root, 'content') : parent
      await rename(target, `${target}-held`)
      await symlink(`${target}-held`, target, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() =>
        removeAnchoredFile(root, join('content', 'blobs'), 'attempt.tmp', identity)
      ).toThrow()
      expect(await readFile(join(parent, 'attempt.tmp'), 'utf8')).toBe('keep')
    }
  )

  it('rejects traversal and directory leaves without removing their contents', async () => {
    cleanupRoot = await mkdtemp(join(tmpdir(), 'safe-file-removal-'))
    const identity = await lstat(cleanupRoot, { bigint: true })
    await mkdir(join(cleanupRoot, 'nested'))
    await writeFile(join(cleanupRoot, 'nested', 'keep'), 'keep')
    expect(() => removeAnchoredFile(cleanupRoot!, '..', 'anything', identity)).toThrow()
    expect(() => removeAnchoredFile(cleanupRoot!, '', '../anything', identity)).toThrow()
    expect(() => removeAnchoredFile(cleanupRoot!, '', 'nested', identity)).toThrow()
    expect(await readFile(join(cleanupRoot, 'nested', 'keep'), 'utf8')).toBe('keep')
  })
})
