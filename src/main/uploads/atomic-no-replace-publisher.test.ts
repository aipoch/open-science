import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { publishNoReplace } from './atomic-no-replace-publisher'

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
