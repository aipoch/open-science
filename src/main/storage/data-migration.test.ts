import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const diskSpace = vi.hoisted(() => ({
  availableBytes: undefined as number | undefined,
  hardLinksSupported: true,
  statErrorPath: undefined as string | undefined
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const statfs = vi.fn(async (path: Parameters<typeof actual.statfs>[0]) => {
    if (diskSpace.availableBytes !== undefined) {
      return { bavail: diskSpace.availableBytes, bsize: 1 } as Awaited<
        ReturnType<typeof actual.statfs>
      >
    }
    return actual.statfs(path)
  }) as unknown as typeof actual.statfs

  const link = vi.fn(async (...args: Parameters<typeof actual.link>) => {
    if (!diskSpace.hardLinksSupported) {
      throw Object.assign(new Error('hard links are not supported'), { code: 'EOPNOTSUPP' })
    }
    return actual.link(...args)
  }) as typeof actual.link

  const stat = vi.fn(async (...args: Parameters<typeof actual.stat>) => {
    if (String(args[0]) === diskSpace.statErrorPath) {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    }
    return actual.stat(...args)
  }) as typeof actual.stat

  return { ...actual, link, stat, statfs }
})

import type { MigrationProgress } from '../../shared/storage'
import { copyAndVerify, deleteSources, validateMigrationSourceLinks } from './data-migration'

let from: string
let to: string

beforeEach(async () => {
  from = await mkdtemp(join(tmpdir(), 'ds-migration-from-'))
  to = await mkdtemp(join(tmpdir(), 'ds-migration-to-'))
})

afterEach(async () => {
  diskSpace.availableBytes = undefined
  diskSpace.hardLinksSupported = true
  diskSpace.statErrorPath = undefined
  await rm(from, { recursive: true, force: true })
  await rm(to, { recursive: true, force: true })
})

// Seeds `from/artifacts/a.txt` and `from/uploads/b.txt` with known contents.
const seedFixture = async (): Promise<void> => {
  await mkdir(join(from, 'artifacts'), { recursive: true })
  await mkdir(join(from, 'uploads'), { recursive: true })
  await writeFile(join(from, 'artifacts', 'a.txt'), 'hello artifacts')
  await writeFile(join(from, 'uploads', 'b.txt'), 'hello uploads')
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('validateMigrationSourceLinks', () => {
  it('rejects an absolute target text inside the source even when an intermediate link escapes', async () => {
    const artifacts = join(from, 'artifacts')
    const outside = join(to, 'outside')
    await mkdir(artifacts, { recursive: true })
    await mkdir(outside, { recursive: true })
    await symlink(
      outside,
      join(artifacts, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await symlink(
      join(artifacts, 'alias'),
      join(artifacts, 'absolute-link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(validateMigrationSourceLinks(from, ['artifacts'])).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringMatching(/absolute symbolic link.*current data folder/i)
      })
    )
  })

  it('rejects a missing absolute target whose existing parent resolves inside the source', async () => {
    const artifacts = join(from, 'artifacts')
    const internalParent = join(from, 'internal-parent')
    const outsideAlias = join(to, 'source-alias')
    await mkdir(artifacts, { recursive: true })
    await mkdir(internalParent)
    await mkdir(to, { recursive: true })
    await symlink(internalParent, outsideAlias, process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(
      join(outsideAlias, 'missing-target'),
      join(artifacts, 'absolute-link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(validateMigrationSourceLinks(from, ['artifacts'])).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringMatching(/absolute symbolic link.*current data folder/i)
      })
    )
  })
})

describe('copyAndVerify', () => {
  it('copies dirs, verifies them, and leaves sources intact', async () => {
    await seedFixture()
    const progress: MigrationProgress[] = []
    const result = await copyAndVerify({
      from,
      to,
      dirs: ['artifacts', 'uploads'],
      signal: new AbortController().signal,
      onProgress: (p) => progress.push(p)
    })

    expect(result).toEqual({ ok: true })
    expect(await readFile(join(to, 'artifacts', 'a.txt'), 'utf8')).toBe('hello artifacts')
    expect(await readFile(join(to, 'uploads', 'b.txt'), 'utf8')).toBe('hello uploads')
    // copyAndVerify never touches `from` — the caller decides when to delete.
    expect(await readFile(join(from, 'artifacts', 'a.txt'), 'utf8')).toBe('hello artifacts')
    expect(await readFile(join(from, 'uploads', 'b.txt'), 'utf8')).toBe('hello uploads')

    const scan = progress.find((p) => p.phase === 'scan')
    expect(scan?.totalBytes).toBe('hello artifacts'.length + 'hello uploads'.length)
    const last = progress[progress.length - 1]
    expect(last.copiedBytes).toBe(scan?.totalBytes)

    // Only after copyAndVerify succeeds does the caller delete the sources.
    const deleteResult = await deleteSources(from, ['artifacts', 'uploads'])
    expect(deleteResult).toEqual({ deleted: ['artifacts', 'uploads'], failed: [] })
    expect(await exists(join(from, 'artifacts'))).toBe(false)
    expect(await exists(join(from, 'uploads'))).toBe(false)
  })

  it('copies and verifies top-level SQLite database files in the same migration set', async () => {
    await writeFile(join(from, 'open-science.db'), 'sqlite bytes')

    const result = await copyAndVerify({
      from,
      to,
      dirs: ['open-science.db'],
      signal: new AbortController().signal,
      onProgress: () => {}
    })

    expect(result).toEqual({ ok: true })
    expect(await readFile(join(to, 'open-science.db'), 'utf8')).toBe('sqlite bytes')
    expect(await readFile(join(from, 'open-science.db'), 'utf8')).toBe('sqlite bytes')
  })

  it('preserves file and directory access and modification times', async () => {
    const sourceDir = join(from, 'artifacts')
    const sourceFile = join(sourceDir, 'observations.csv')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(sourceFile, 'time,value\n1,42\n')
    const fileAtime = new Date('2001-02-03T04:05:06.000Z')
    const fileMtime = new Date('2002-03-04T05:06:07.000Z')
    const dirAtime = new Date('2003-04-05T06:07:08.000Z')
    const dirMtime = new Date('2004-05-06T07:08:09.000Z')
    await utimes(sourceFile, fileAtime, fileMtime)
    await utimes(sourceDir, dirAtime, dirMtime)

    const result = await copyAndVerify({
      from,
      to,
      dirs: ['artifacts'],
      signal: new AbortController().signal,
      onProgress: () => {}
    })

    expect(result).toEqual({ ok: true })
    const copiedFile = await stat(join(to, 'artifacts', 'observations.csv'))
    const copiedDir = await stat(join(to, 'artifacts'))
    expect(Math.trunc(copiedFile.atimeMs / 1000)).toBe(Math.trunc(fileAtime.getTime() / 1000))
    expect(Math.trunc(copiedFile.mtimeMs / 1000)).toBe(Math.trunc(fileMtime.getTime() / 1000))
    expect(Math.trunc(copiedDir.atimeMs / 1000)).toBe(Math.trunc(dirAtime.getTime() / 1000))
    expect(Math.trunc(copiedDir.mtimeMs / 1000)).toBe(Math.trunc(dirMtime.getTime() / 1000))
  })

  it.skipIf(process.platform === 'win32')(
    'preserves source directory modes after populating nested content',
    async () => {
      const sourceDir = join(from, 'artifacts')
      const nestedDir = join(sourceDir, 'private')
      await mkdir(nestedDir, { recursive: true })
      await writeFile(join(nestedDir, 'results.txt'), 'classified')
      await chmod(nestedDir, 0o700)
      await chmod(sourceDir, 0o750)

      const result = await copyAndVerify({
        from,
        to,
        dirs: ['artifacts'],
        signal: new AbortController().signal,
        onProgress: () => {}
      })

      expect(result).toEqual({ ok: true })
      expect((await stat(join(to, 'artifacts'))).mode & 0o777).toBe(0o750)
      expect((await stat(join(to, 'artifacts', 'private'))).mode & 0o777).toBe(0o700)
    }
  )

  it('preserves hard-link relationships instead of duplicating linked file data', async () => {
    const sourceDir = join(from, 'artifacts')
    const sourceOriginal = join(sourceDir, 'dataset.bin')
    const sourceAlias = join(sourceDir, 'dataset-alias.bin')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(sourceOriginal, 'shared-data')
    await link(sourceOriginal, sourceAlias)

    const result = await copyAndVerify({
      from,
      to,
      dirs: ['artifacts'],
      signal: new AbortController().signal,
      onProgress: () => {}
    })

    expect(result).toEqual({ ok: true })
    await writeFile(join(to, 'artifacts', 'dataset.bin'), 'updated')
    expect(await readFile(join(to, 'artifacts', 'dataset-alias.bin'), 'utf8')).toBe('updated')
    expect(await readFile(sourceAlias, 'utf8')).toBe('shared-data')
  })

  it('falls back to independent copies when the destination does not support hard links', async () => {
    const sourceDir = join(from, 'artifacts')
    const sourceOriginal = join(sourceDir, 'dataset.bin')
    const sourceAlias = join(sourceDir, 'dataset-alias.bin')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(sourceOriginal, 'shared-data')
    await link(sourceOriginal, sourceAlias)
    diskSpace.hardLinksSupported = false
    const progress: MigrationProgress[] = []

    const result = await copyAndVerify({
      from,
      to,
      dirs: ['artifacts'],
      signal: new AbortController().signal,
      onProgress: (entry) => progress.push(entry)
    })

    expect(result).toEqual({ ok: true })
    expect(progress.find((entry) => entry.phase === 'scan')?.totalBytes).toBe(
      2 * Buffer.byteLength('shared-data')
    )
    await writeFile(join(to, 'artifacts', 'dataset.bin'), 'updated')
    expect(await readFile(join(to, 'artifacts', 'dataset-alias.bin'), 'utf8')).toBe('shared-data')
  })

  it('accounts for fallback hard-link copies in the destination capacity preflight', async () => {
    const sourceDir = join(from, 'artifacts')
    const sourceOriginal = join(sourceDir, 'dataset.bin')
    const sourceAlias = join(sourceDir, 'dataset-alias.bin')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(sourceOriginal, 'shared-data')
    await link(sourceOriginal, sourceAlias)
    diskSpace.hardLinksSupported = false
    diskSpace.availableBytes = Buffer.byteLength('shared-data') + 1
    const progress: MigrationProgress[] = []

    const result = await copyAndVerify({
      from,
      to,
      dirs: ['artifacts'],
      signal: new AbortController().signal,
      onProgress: (entry) => progress.push(entry)
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/space/i)
    expect(progress).toEqual([
      {
        phase: 'scan',
        copiedBytes: 0,
        totalBytes: 2 * Buffer.byteLength('shared-data')
      }
    ])
    expect(await exists(join(to, 'artifacts'))).toBe(false)
  })

  it('rejects insufficient destination capacity after scanning and before copying', async () => {
    await seedFixture()
    diskSpace.availableBytes = 1
    const progress: MigrationProgress[] = []

    const result = await copyAndVerify({
      from,
      to,
      dirs: ['artifacts', 'uploads'],
      signal: new AbortController().signal,
      onProgress: (entry) => progress.push(entry)
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/space/i)
    expect(progress.map((entry) => entry.phase)).toEqual(['scan'])
    expect(await exists(join(to, 'artifacts'))).toBe(false)
    expect(await exists(join(to, 'uploads'))).toBe(false)
  })

  it('rejects a same-size destination corruption during content verification', async () => {
    await seedFixture()
    let corrupted = false
    const result = await copyAndVerify({
      from,
      to,
      dirs: ['artifacts', 'uploads'],
      signal: new AbortController().signal,
      onProgress: (progress) => {
        if (
          !corrupted &&
          progress.phase === 'copy' &&
          progress.currentPath === join('artifacts', 'a.txt')
        ) {
          corrupted = true
          writeFileSync(join(to, 'artifacts', 'a.txt'), 'jello artifacts')
        }
      }
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/verification failed.*a\.txt/i)
    expect(await readFile(join(from, 'artifacts', 'a.txt'), 'utf8')).toBe('hello artifacts')
    expect(await exists(join(to, 'artifacts'))).toBe(false)
  })

  // Windows has no POSIX mode bits, so the executable-bit assertion is unix-only.
  it.skipIf(process.platform === 'win32')(
    'preserves the source file mode (executable bit survives the copy)',
    async () => {
      // A runtime/pkgs binary that micromamba hard-links into a relocated env: if the copy drops +x,
      // the rebuilt env's Rscript/.dylib fails with EACCES. Mirror that with an executable fixture.
      await mkdir(join(from, 'runtime', 'pkgs'), { recursive: true })
      const exe = join(from, 'runtime', 'pkgs', 'Rscript')
      await writeFile(exe, '#!/bin/sh\necho hi\n')
      await chmod(exe, 0o755)

      const result = await copyAndVerify({
        from,
        to,
        dirs: [join('runtime', 'pkgs')],
        signal: new AbortController().signal,
        onProgress: () => {}
      })

      expect(result).toEqual({ ok: true })
      const copiedMode = (await stat(join(to, 'runtime', 'pkgs', 'Rscript'))).mode & 0o777
      expect(copiedMode).toBe(0o755)
    }
  )

  it('cancels mid-copy, leaves sources intact, and cleans partial dest', async () => {
    await seedFixture()
    // Add more files so there's something to cancel between.
    await writeFile(join(from, 'artifacts', 'a2.txt'), 'more artifacts data')
    const controller = new AbortController()
    let seenFirstProgress = false
    const result = await copyAndVerify({
      from,
      to,
      dirs: ['artifacts', 'uploads'],
      signal: controller.signal,
      onProgress: () => {
        if (!seenFirstProgress) {
          seenFirstProgress = true
          controller.abort()
        }
      }
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.cancelled).toBe(true)
    // Sources must be fully intact.
    expect(await readFile(join(from, 'artifacts', 'a.txt'), 'utf8')).toBe('hello artifacts')
    expect(await readFile(join(from, 'uploads', 'b.txt'), 'utf8')).toBe('hello uploads')
    // No leftover partial tree under `to`.
    expect(await exists(join(to, 'artifacts'))).toBe(false)
    expect(await exists(join(to, 'uploads'))).toBe(false)
  })

  it('rolls back partial copies on failure and leaves sources intact', async () => {
    await seedFixture()
    // Make `to` read-only so writes into it fail (simulate a copy error).
    await rm(to, { recursive: true, force: true })
    await mkdir(to, { recursive: true })
    await writeFile(join(to, 'artifacts'), 'blocker file, not a dir')

    const result = await copyAndVerify({
      from,
      to,
      dirs: ['artifacts', 'uploads'],
      signal: new AbortController().signal,
      onProgress: () => {}
    })

    expect(result.ok).toBe(false)
    // Sources must be fully intact.
    expect(await readFile(join(from, 'artifacts', 'a.txt'), 'utf8')).toBe('hello artifacts')
    expect(await readFile(join(from, 'uploads', 'b.txt'), 'utf8')).toBe('hello uploads')
  })

  it('tolerates a missing source dir without error', async () => {
    await seedFixture()
    const result = await copyAndVerify({
      from,
      to,
      dirs: ['artifacts', 'uploads', 'runtime'],
      signal: new AbortController().signal,
      onProgress: () => {}
    })

    expect(result).toEqual({ ok: true })
    expect(await exists(join(to, 'runtime'))).toBe(false)
    expect(await readFile(join(to, 'artifacts', 'a.txt'), 'utf8')).toBe('hello artifacts')
  })

  it('treats a missing source root as an empty migration', async () => {
    await rm(from, { recursive: true })

    const result = await copyAndVerify({
      from,
      to,
      dirs: ['artifacts', 'uploads'],
      signal: new AbortController().signal,
      onProgress: () => {}
    })

    expect(result).toEqual({ ok: true })
    expect(await exists(join(to, 'artifacts'))).toBe(false)
    expect(await exists(join(to, 'uploads'))).toBe(false)
  })

  // Symlink creation needs privilege on Windows, so skip there.
  it.skipIf(process.platform === 'win32')(
    'preserves an inner symlink by recreating it as a link at the destination (conda cache support)',
    async () => {
      // Mirrors the conda pkgs cache (runtime/pkgs): a package dir with a relative symlink like
      // ca-certificates' cert.pem, which the old strict engine rejected outright.
      await mkdir(join(from, 'runtime', 'pkgs', 'ca-certs'), { recursive: true })
      await writeFile(join(from, 'runtime', 'pkgs', 'ca-certs', 'cacert.pem'), 'CERT')
      await symlink('cacert.pem', join(from, 'runtime', 'pkgs', 'ca-certs', 'cert.pem'))

      const result = await copyAndVerify({
        from,
        to,
        dirs: [join('runtime', 'pkgs')],
        signal: new AbortController().signal,
        onProgress: () => {}
      })

      expect(result).toEqual({ ok: true })
      // The link is recreated AS a symlink (not followed and copied as a regular file), verbatim target.
      const destLink = join(to, 'runtime', 'pkgs', 'ca-certs', 'cert.pem')
      expect((await lstat(destLink)).isSymbolicLink()).toBe(true)
      expect(await readlink(destLink)).toBe('cacert.pem')
      // The regular file it points at was copied too.
      expect(await readFile(join(to, 'runtime', 'pkgs', 'ca-certs', 'cacert.pem'), 'utf8')).toBe(
        'CERT'
      )
    }
  )

  it.skipIf(process.platform === 'win32')(
    'still refuses a true special file (fifo) it cannot copy',
    async () => {
      await mkdir(join(from, 'artifacts'), { recursive: true })
      const { execFileSync } = await import('node:child_process')
      // mkfifo is POSIX; if unavailable on the runner, skip the assertion rather than fail spuriously.
      let fifoMade = true
      try {
        execFileSync('mkfifo', [join(from, 'artifacts', 'pipe')])
      } catch {
        fifoMade = false
      }
      if (!fifoMade) return

      const result = await copyAndVerify({
        from,
        to,
        dirs: ['artifacts'],
        signal: new AbortController().signal,
        onProgress: () => {}
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/special file/i)
      expect(await exists(join(to, 'artifacts'))).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses to migrate when a top-level migrated dir is itself a symlink',
    async () => {
      await mkdir(join(from, 'real-artifacts'), { recursive: true })
      await writeFile(join(from, 'real-artifacts', 'a.txt'), 'x')
      await symlink(join(from, 'real-artifacts'), join(from, 'artifacts'))

      const result = await copyAndVerify({
        from,
        to,
        dirs: ['artifacts'],
        signal: new AbortController().signal,
        onProgress: () => {}
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/symbolic link|special file/i)
      // The source symlink is untouched and nothing was copied to the dest.
      expect(await exists(join(from, 'artifacts'))).toBe(true)
      expect(await exists(join(to, 'artifacts'))).toBe(false)
    }
  )

  it('copies an existing-but-empty source dir instead of dropping it', async () => {
    await seedFixture()
    await mkdir(join(from, 'runtime'), { recursive: true })

    const result = await copyAndVerify({
      from,
      to,
      dirs: ['artifacts', 'uploads', 'runtime'],
      signal: new AbortController().signal,
      onProgress: () => {}
    })

    expect(result).toEqual({ ok: true })
    expect(await exists(join(to, 'runtime'))).toBe(true)
    // Still present at `from` — copyAndVerify never deletes sources.
    expect(await exists(join(from, 'runtime'))).toBe(true)

    const deleteResult = await deleteSources(from, ['artifacts', 'uploads', 'runtime'])
    expect(deleteResult.failed).toEqual([])
    expect(await exists(join(from, 'runtime'))).toBe(false)
  })

  it('preserves nested empty directories before the source tree is deleted', async () => {
    await mkdir(join(from, 'artifacts', 'empty', 'nested'), { recursive: true })

    const result = await copyAndVerify({
      from,
      to,
      dirs: ['artifacts'],
      signal: new AbortController().signal,
      onProgress: () => {}
    })

    expect(result).toEqual({ ok: true })
    expect(await exists(join(to, 'artifacts', 'empty', 'nested'))).toBe(true)

    await deleteSources(from, ['artifacts'])
    expect(await exists(join(from, 'artifacts', 'empty', 'nested'))).toBe(false)
    expect(await exists(join(to, 'artifacts', 'empty', 'nested'))).toBe(true)
  })
})

describe('deleteSources', () => {
  it('is a no-op for dirs that do not exist at `from`', async () => {
    const result = await deleteSources(from, ['artifacts', 'uploads', 'runtime'])
    expect(result).toEqual({ deleted: [], failed: [] })
  })

  it('deletes every existing dir and reports it in `deleted`', async () => {
    await seedFixture()
    const progress: MigrationProgress[] = []
    const result = await deleteSources(from, ['artifacts', 'uploads'], (p) => progress.push(p))

    expect(result).toEqual({ deleted: ['artifacts', 'uploads'], failed: [] })
    expect(await exists(join(from, 'artifacts'))).toBe(false)
    expect(await exists(join(from, 'uploads'))).toBe(false)
    expect(progress.every((p) => p.phase === 'delete')).toBe(true)
  })

  it('reports a source probe error instead of treating the directory as absent', async () => {
    await seedFixture()
    const uploadsDir = join(from, 'uploads')
    diskSpace.statErrorPath = uploadsDir

    const result = await deleteSources(from, ['artifacts', 'uploads'])

    expect(result.deleted).toEqual(['artifacts'])
    expect(result.failed).toEqual([{ dir: 'uploads', error: 'permission denied' }])
    diskSpace.statErrorPath = undefined
    await expect(readFile(join(uploadsDir, 'b.txt'), 'utf8')).resolves.toBe('hello uploads')
  })

  it('records a per-dir failure in `failed` without throwing, and still deletes the rest', async () => {
    await seedFixture()
    const uploadsDir = join(from, 'uploads')
    // Strip write permission on `uploads` itself so its child file can't be unlinked.
    let permsEnforced = true
    await chmod(uploadsDir, 0o500)
    try {
      // Sanity check: some environments (e.g. running as root) ignore this restriction.
      await writeFile(join(uploadsDir, 'probe-write.tmp'), 'x')
      permsEnforced = false
      await rm(join(uploadsDir, 'probe-write.tmp'), { force: true })
    } catch {
      // Expected: EACCES means permissions are enforced, so the real test can proceed.
    }

    try {
      if (!permsEnforced) return

      const result = await deleteSources(from, ['artifacts', 'uploads'])

      expect(result.deleted).toEqual(['artifacts'])
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0].dir).toBe('uploads')
      expect(await exists(join(from, 'artifacts'))).toBe(false)
      expect(await exists(join(from, 'uploads'))).toBe(true)
    } finally {
      await chmod(uploadsDir, 0o700).catch(() => undefined)
    }
  })
})
