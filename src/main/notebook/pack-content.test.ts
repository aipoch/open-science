import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { micromambaCacheLockKey } from './micromamba-cache'
import { validateAndSeedPack } from './pack-content'
import { withSharedCacheLock } from './pkgs-cache-lock'
import { pkgsCache } from './runtime-paths'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

describe('validateAndSeedPack', () => {
  it('waits for users of the physical legacy cache before publishing a tarball', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-pack-seed-lock-'))
    const packDir = join(root, 'pack')
    const packageFile = 'package-1.0-0.conda'
    const packageBytes = 'verified package bytes'
    const md5 = createHash('md5').update(packageBytes).digest('hex')
    const lockPath = join(packDir, 'python-3.12.lock')
    const destination = join(pkgsCache(root), packageFile)
    mkdirSync(packDir, { recursive: true })
    writeFileSync(lockPath, `@EXPLICIT\nhttps://host/win-64/${packageFile}#${md5}\n`, {
      flag: 'wx'
    })
    writeFileSync(join(packDir, packageFile), packageBytes)

    const key = micromambaCacheLockKey(pkgsCache(root))
    let releaseReader!: () => void
    let readerEntered!: () => void
    const release = new Promise<void>((resolve) => {
      releaseReader = resolve
    })
    const entered = new Promise<void>((resolve) => {
      readerEntered = resolve
    })
    const reader = withSharedCacheLock(key, async () => {
      readerEntered()
      await release
    })
    await entered

    const seed = validateAndSeedPack(root, packDir, lockPath)
    await tick()
    expect(existsSync(destination)).toBe(false)

    releaseReader()
    await Promise.all([reader, seed])
    await expect(readFile(destination, 'utf8')).resolves.toBe(packageBytes)
  })
})
