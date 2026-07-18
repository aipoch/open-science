import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { copyAndVerify, deleteSources, type MigrationProgress } from './data-migration'

let from: string
let to: string

beforeEach(async () => {
  from = await mkdtemp(join(tmpdir(), 'ds-migration-from-'))
  to = await mkdtemp(join(tmpdir(), 'ds-migration-to-'))
})

afterEach(async () => {
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

describe('copyAndVerify', () => {
  it('copies dirs on the same volume, verifies them, and leaves sources intact', async () => {
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

  it('forces the byte-copy branch (simulated cross-device) and produces the same result', async () => {
    await seedFixture()
    const progress: MigrationProgress[] = []
    const result = await copyAndVerify({
      from,
      to,
      dirs: ['artifacts', 'uploads'],
      signal: new AbortController().signal,
      onProgress: (p) => progress.push(p),
      forceCopy: true
    })

    expect(result).toEqual({ ok: true })
    expect(await readFile(join(to, 'artifacts', 'a.txt'), 'utf8')).toBe('hello artifacts')
    expect(await readFile(join(to, 'uploads', 'b.txt'), 'utf8')).toBe('hello uploads')
    expect(progress.some((p) => p.phase === 'copy')).toBe(true)

    const deleteResult = await deleteSources(from, ['artifacts', 'uploads'])
    expect(deleteResult.failed).toEqual([])
    expect(await exists(join(from, 'artifacts'))).toBe(false)
    expect(await exists(join(from, 'uploads'))).toBe(false)
  })

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
      forceCopy: true,
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
      onProgress: () => {},
      forceCopy: true
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

  // Symlink creation needs privilege on Windows, so skip there.
  it.skipIf(process.platform === 'win32')(
    'refuses to migrate when a source dir holds a symlink, leaving sources and dest untouched',
    async () => {
      await mkdir(join(from, 'artifacts'), { recursive: true })
      await writeFile(join(from, 'artifacts', 'a.txt'), 'hello artifacts')
      const linkPath = join(from, 'artifacts', 'link')
      await symlink(join(from, 'artifacts', 'a.txt'), linkPath)

      const result = await copyAndVerify({
        from,
        to,
        dirs: ['artifacts'],
        signal: new AbortController().signal,
        onProgress: () => {}
      })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/symbolic link|special file/i)
      // Source file and the link itself are untouched (caller only deletes on ok).
      expect(await readFile(join(from, 'artifacts', 'a.txt'), 'utf8')).toBe('hello artifacts')
      expect(await exists(linkPath)).toBe(true)
      // No partial dest tree remains.
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
