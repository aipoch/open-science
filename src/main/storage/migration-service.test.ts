import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// classifyDataRoot now derives the target via storage-root's dataRootForParent, so migration-service
// transitively needs the electron app stub too (packaged: folder name 'OpenScience').
vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

import type { MigrationProgress, MigrationResult } from './data-migration'
import {
  classifyDataRoot,
  commitDataRootSwitch,
  DATA_ROOT_DIRS,
  MIGRATED_DIRS,
  runDataRootMigration,
  validateNewDataRoot
} from './migration-service'

// Data folder name mirrors dataFolderName() for a packaged build (see the electron mock above).
const dataRootFor = (parent: string): string => join(parent, 'OpenScience')

let currentParent: string
let currentDataRoot: string
let emptyParent: string

beforeEach(async () => {
  currentParent = await mkdtemp(join(tmpdir(), 'ds-migsvc-current-'))
  currentDataRoot = dataRootFor(currentParent)
  await mkdir(currentDataRoot)
  emptyParent = await mkdtemp(join(tmpdir(), 'ds-migsvc-target-'))
})

afterEach(async () => {
  await rm(currentParent, { recursive: true, force: true })
  await rm(emptyParent, { recursive: true, force: true })
})

describe('classifyDataRoot', () => {
  it('classifies the parent whose derived target equals the current data root as invalid (same)', async () => {
    const result = await classifyDataRoot(currentParent, currentDataRoot)

    expect(result).toEqual({
      kind: 'invalid',
      error: 'The new location is the same as the current one.'
    })
  })

  it('treats picking the current data folder itself as "same", not a doubled nested path', async () => {
    // currentDataRoot's basename is already the data folder name, so it is used as-is (no second
    // OpenScience appended) — the fix for the "<root>/OpenScience/OpenScience" not-found bug.
    const result = await classifyDataRoot(currentDataRoot, currentDataRoot)

    expect(result).toEqual({
      kind: 'invalid',
      error: 'The new location is the same as the current one.'
    })
  })

  it('classifies a non-OpenScience subfolder of the current data root as invalid (inside)', async () => {
    // A picked folder NOT named OpenScience gets the name appended, landing inside the current root.
    const result = await classifyDataRoot(join(currentDataRoot, 'sub'), currentDataRoot)

    expect(result).toEqual({
      kind: 'invalid',
      error: 'Choose a location outside the current data folder.'
    })
  })

  it('adopts the picked OpenScience folder itself as-is, without appending a second folder', async () => {
    // User navigates INTO and selects the OpenScience folder (which already holds data). It must be
    // adopted directly, not derive <picked>/OpenScience (doubled, empty, not-found).
    const picked = dataRootFor(emptyParent)
    await mkdir(join(picked, 'artifacts'), { recursive: true })

    const result = await classifyDataRoot(picked, currentDataRoot)

    expect(result).toEqual({ kind: 'adopt' })
  })

  it('classifies a missing parent as invalid', async () => {
    const missing = join(emptyParent, 'does-not-exist')

    const result = await classifyDataRoot(missing, currentDataRoot)

    expect(result).toEqual({ kind: 'invalid', error: 'The selected folder does not exist.' })
  })

  it('rejects a spaced path on macOS/Linux (conda/venv shebang limit)', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const spacedParent = await mkdtemp(join(tmpdir(), 'ds migsvc spaced '))

    try {
      const result = await classifyDataRoot(spacedParent, currentDataRoot)

      expect(result.kind).toBe('invalid')
      expect(result.error).toMatch(/no spaces/i)
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
      await rm(spacedParent, { recursive: true, force: true })
    }
  })

  it('allows a spaced path on Windows (spaces are normal there)', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const spacedParent = await mkdtemp(join(tmpdir(), 'ds migsvc spaced win '))

    try {
      const result = await classifyDataRoot(spacedParent, currentDataRoot)

      expect(result).toEqual({ kind: 'move' })
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
      await rm(spacedParent, { recursive: true, force: true })
    }
  })

  it('rejects a target whose path is too long for Windows MAX_PATH', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    try {
      // No fs access happens before this check trips, so a synthetic (never-created) long path
      // works. A plain posix-style absolute path is used rather than a `C:\...` one because Node's
      // `path` module picks win32 vs. posix semantics from the real host platform at import time,
      // not from this mocked process.platform.
      const longParent = `/${'a'.repeat(220)}`
      const result = await classifyDataRoot(longParent, currentDataRoot)

      expect(result.kind).toBe('invalid')
      expect(result.error).toMatch(/too long|260/i)
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('does not reject a normal short target on Windows for length', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    try {
      const result = await classifyDataRoot(emptyParent, currentDataRoot)

      expect(result.kind).not.toBe('invalid')
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('does not enforce MAX_PATH on non-Windows platforms, even for a very long path', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

    try {
      const longParent = `/tmp/${'a'.repeat(220)}`
      const result = await classifyDataRoot(longParent, currentDataRoot)

      // POSIX has no MAX_PATH; this only fails (or not) for unrelated reasons (missing dir), never
      // for length.
      expect(result.error).not.toMatch(/too long|260/i)
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('rejects a parent whose derived path contains a control character', async () => {
    // The control-char check runs before any fs access, so a synthetic (never-created) path is fine.
    const result = await classifyDataRoot('/tmp/bad\u0001name', currentDataRoot)

    expect(result.kind).toBe('invalid')
    expect(result.error).toMatch(/control characters/i)
  })

  // chmod's write bit is a POSIX concept; on Windows it doesn't stop directory writes, so the write
  // probe would succeed and this scenario can't be reproduced there. The probe itself is unchanged.
  it.skipIf(process.platform === 'win32')(
    'classifies a non-writable parent as invalid (write probe fails)',
    async () => {
      const readonlyParent = await mkdtemp(join(tmpdir(), 'ds-migsvc-readonly-'))
      await chmod(readonlyParent, 0o500)

      try {
        const result = await classifyDataRoot(readonlyParent, currentDataRoot)

        expect(result.kind).toBe('invalid')
        expect(result.error).toMatch(/can't write to this folder/i)
      } finally {
        await chmod(readonlyParent, 0o700)
        await rm(readonlyParent, { recursive: true, force: true })
      }
    }
  )

  it('classifies a parent as invalid when the injected write probe reports failure (all platforms)', async () => {
    const result = await classifyDataRoot(emptyParent, currentDataRoot, {
      canWrite: async () => false
    })

    expect(result.kind).toBe('invalid')
    expect(result.error).toMatch(/can't write/i)
  })

  it('classifies a parent with no OpenScience subdir as move', async () => {
    const result = await classifyDataRoot(emptyParent, currentDataRoot)

    expect(result).toEqual({ kind: 'move' })
  })

  it('classifies an OpenScience folder containing a known data subdir as adopt', async () => {
    await mkdir(join(dataRootFor(emptyParent), 'artifacts'), { recursive: true })

    const result = await classifyDataRoot(emptyParent, currentDataRoot)

    expect(result).toEqual({ kind: 'adopt' })
  })

  it('adopts on ANY known subdir, not all (a partial data folder still adopts)', async () => {
    // Only notebooks/ present — no artifacts/uploads/runtime. A real data folder is often partial.
    await mkdir(join(dataRootFor(emptyParent), 'notebooks'), { recursive: true })

    const result = await classifyDataRoot(emptyParent, currentDataRoot)

    expect(result).toEqual({ kind: 'adopt' })
  })

  it('classifies an EMPTY OpenScience folder as move (populate it), not adopt', async () => {
    await mkdir(dataRootFor(emptyParent))

    const result = await classifyDataRoot(emptyParent, currentDataRoot)

    expect(result).toEqual({ kind: 'move' })
  })

  it('classifies a non-empty OpenScience folder with none of our subdirs as invalid (foreign)', async () => {
    await mkdir(join(dataRootFor(emptyParent), 'someone-elses-stuff'), { recursive: true })

    const result = await classifyDataRoot(emptyParent, currentDataRoot)

    expect(result).toEqual({
      kind: 'invalid',
      error: 'A different folder named OpenScience already exists here. Choose another location.'
    })
  })

  it('classifies an OpenScience folder holding only runtime/ as move (runtime is not user data)', async () => {
    // A leftover runtime/ from a prior move (runtime is excluded from moves) must not look adoptable.
    await mkdir(join(dataRootFor(emptyParent), 'runtime'), { recursive: true })

    const result = await classifyDataRoot(emptyParent, currentDataRoot)

    expect(result).toEqual({ kind: 'move' })
  })

  it('still adopts when user data is present even if runtime/ sits alongside it', async () => {
    await mkdir(join(dataRootFor(emptyParent), 'artifacts'), { recursive: true })
    await mkdir(join(dataRootFor(emptyParent), 'runtime'), { recursive: true })

    const result = await classifyDataRoot(emptyParent, currentDataRoot)

    expect(result).toEqual({ kind: 'adopt' })
  })

  it('classifies runtime/ plus a foreign file (no user data) as invalid', async () => {
    // The round-trip edge (design §21.5): after moving away, the old folder keeps runtime/ + a
    // manually-placed file but no user data — the foreign file blocks it, runtime alone would not.
    const target = dataRootFor(emptyParent)
    await mkdir(join(target, 'runtime'), { recursive: true })
    await writeFile(join(target, 'a.pdf'), 'x')

    const result = await classifyDataRoot(emptyParent, currentDataRoot)

    expect(result).toEqual({
      kind: 'invalid',
      error: 'A different folder named OpenScience already exists here. Choose another location.'
    })
  })
})

describe('validateNewDataRoot', () => {
  it('rejects a parent whose derived target is the same as the current data root', async () => {
    const result = await validateNewDataRoot(currentParent, currentDataRoot)

    expect(result).toEqual({ ok: false, error: 'The new location is the same as the current one.' })
  })

  it('rejects picking the current data folder itself as "same" (no doubled path)', async () => {
    const result = await validateNewDataRoot(currentDataRoot, currentDataRoot)

    expect(result).toEqual({
      ok: false,
      error: 'The new location is the same as the current one.'
    })
  })

  it('rejects a missing parent', async () => {
    const missing = join(emptyParent, 'does-not-exist')

    const result = await validateNewDataRoot(missing, currentDataRoot)

    expect(result).toEqual({ ok: false, error: 'The selected folder does not exist.' })
  })

  it('accepts a parent with no OpenScience subdir yet (move)', async () => {
    const result = await validateNewDataRoot(emptyParent, currentDataRoot)

    expect(result).toEqual({ ok: true })
  })

  it('accepts an EMPTY OpenScience folder as move', async () => {
    await mkdir(dataRootFor(emptyParent))

    const result = await validateNewDataRoot(emptyParent, currentDataRoot)

    expect(result).toEqual({ ok: true })
  })

  it('is ok only for move - an OpenScience folder that already holds our data (adopt) is rejected', async () => {
    await mkdir(join(dataRootFor(emptyParent), 'artifacts'), { recursive: true })

    const result = await validateNewDataRoot(emptyParent, currentDataRoot)

    expect(result).toEqual({
      ok: false,
      error: 'The selected folder already contains Open Science data. Pick an empty folder.'
    })
  })
})

type FakeDeps = {
  currentDataRoot: string
  runtime: { disconnect: Mock<() => Promise<unknown>> }
  notebook: { shutdownAll: Mock<() => Promise<void>> }
  setDataRoot: Mock<(path: string) => Promise<void>>
}

// Fresh, independently-controllable fake deps for each test.
const fakeDeps = (): FakeDeps => ({
  currentDataRoot,
  runtime: { disconnect: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined) },
  notebook: { shutdownAll: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) },
  setDataRoot: vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
})

const runOpts = (): { signal: AbortSignal; onProgress: (p: MigrationProgress) => void } => ({
  signal: new AbortController().signal,
  onProgress: () => {}
})

type DeleteResult = { deleted: string[]; failed: { dir: string; error: string }[] }

describe('runDataRootMigration (copy phase)', () => {
  it('interrupts sessions then copies+verifies into the target, committing nothing', async () => {
    const order: string[] = []
    const deps = fakeDeps()
    deps.runtime.disconnect.mockImplementation(async () => {
      order.push('disconnect')
    })
    deps.notebook.shutdownAll.mockImplementation(async () => {
      order.push('shutdownAll')
    })
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => {
      order.push('copyAndVerify')
      return { ok: true }
    })

    const target = dataRootFor(emptyParent)
    const result = await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({ ok: true })
    // Copy phase commits nothing: interrupt -> copy, and that's it. No setDataRoot, no delete.
    expect(order).toEqual(['disconnect', 'shutdownAll', 'copyAndVerify'])
    expect(copyAndVerify).toHaveBeenCalledWith(
      expect.objectContaining({
        from: currentDataRoot,
        to: target,
        dirs: [...MIGRATED_DIRS]
      })
    )
    // runtime/ is excluded from the moved set (non-relocatable; rebuilt on demand).
    expect(MIGRATED_DIRS).not.toContain('runtime')
    expect(DATA_ROOT_DIRS).toContain('runtime')
    expect(deps.setDataRoot).not.toHaveBeenCalled()
  })

  it('returns the copy failure untouched', async () => {
    const deps = fakeDeps()
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: false, error: 'x' }))

    const result = await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({ ok: false, error: 'x' })
    expect(deps.setDataRoot).not.toHaveBeenCalled()
  })

  it('short-circuits on validation failure without interrupting or copying', async () => {
    const deps = fakeDeps()
    const copyAndVerify = vi.fn()

    // currentParent derives currentDataRoot itself as the target, rejected by validateNewDataRoot.
    const result = await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify },
      currentParent,
      runOpts()
    )

    expect(result).toEqual({
      ok: false,
      error: 'The new location is the same as the current one.'
    })
    expect(deps.runtime.disconnect).not.toHaveBeenCalled()
    expect(deps.notebook.shutdownAll).not.toHaveBeenCalled()
    expect(copyAndVerify).not.toHaveBeenCalled()
  })

  it('swallows an interrupt failure and still completes the copy', async () => {
    const deps = fakeDeps()
    deps.runtime.disconnect.mockRejectedValue(new Error('disconnect boom'))
    deps.notebook.shutdownAll.mockRejectedValue(new Error('shutdown boom'))
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))

    const result = await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({ ok: true })
    expect(copyAndVerify).toHaveBeenCalledTimes(1)
  })
})

describe('commitDataRootSwitch (commit phase)', () => {
  it('persists the new root then deletes the old dirs, in that order', async () => {
    const order: string[] = []
    const deps = fakeDeps()
    deps.setDataRoot.mockImplementation(async () => {
      order.push('setDataRoot')
    })
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => {
      order.push('deleteSources')
      return { deleted: [...MIGRATED_DIRS], failed: [] }
    })

    const target = dataRootFor(emptyParent)
    const result = await commitDataRootSwitch(
      { currentDataRoot, setDataRoot: deps.setDataRoot, deleteSources },
      emptyParent
    )

    expect(result).toEqual({ ok: true })
    // setDataRoot MUST precede delete: once the pointer is committed, an interrupted delete only
    // orphans the old root; the reverse order could strand data.
    expect(order).toEqual(['setDataRoot', 'deleteSources'])
    expect(deps.setDataRoot).toHaveBeenCalledWith(target)
    expect(deleteSources).toHaveBeenCalledWith(currentDataRoot, [...MIGRATED_DIRS])
  })

  it('returns switchoverFailed and skips delete when setDataRoot fails, leaving both roots intact', async () => {
    const deps = fakeDeps()
    deps.setDataRoot.mockRejectedValue(new Error('disk full'))
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] }))

    const target = dataRootFor(emptyParent)
    const result = await commitDataRootSwitch(
      { currentDataRoot, setDataRoot: deps.setDataRoot, deleteSources },
      emptyParent
    )

    expect(result).toEqual({
      ok: false,
      error: `Your data was copied to ${target}, but the app could not finish switching over. Please try again; your current data is untouched.`,
      switchoverFailed: true
    })
    expect(deleteSources).not.toHaveBeenCalled()
  })

  it('still succeeds when deleteSources reports per-dir failures (harmless leftovers)', async () => {
    const deps = fakeDeps()
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({
      deleted: ['artifacts'],
      failed: [{ dir: 'uploads', error: 'EACCES' }]
    }))

    const result = await commitDataRootSwitch(
      { currentDataRoot, setDataRoot: deps.setDataRoot, deleteSources },
      emptyParent
    )

    expect(result).toEqual({ ok: true })
  })
})
