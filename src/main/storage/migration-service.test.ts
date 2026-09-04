import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// classifyDataRoot now derives the target via storage-root's dataRootForParent, so migration-service
// transitively needs the electron app stub too (packaged: folder name 'OpenScience').
vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))
vi.mock('./remote-data-root', () => ({
  inspectWindowsStoragePath: () => ({ isRemote: false, supportsHardLinks: true })
}))

import { existsSync, symlinkSync } from 'node:fs'

import type { MigrationProgress, MigrationResult } from '../../shared/storage'
import {
  classifyDataRoot,
  commitDataRootSwitch,
  DATA_ROOT_DIRS,
  discardStagedCopy,
  MIGRATED_DIRS,
  PROJECT_DATABASE_FILE,
  RUNTIME_ENVIRONMENT_MANIFESTS_DIR,
  RUNTIME_REPAIR_REGISTRY_FILE,
  runDataRootMigration,
  validateNewDataRoot
} from './migration-service'
import {
  MIGRATION_MARKER_FILENAME,
  readMigrationMarker,
  scanInventory,
  writeMigrationMarker,
  type MigrationMarker
} from './migration-marker'
import { withDataRootWrite } from './migration-state'
import { operationJournalPath, RuntimeOperationJournal } from '../notebook/operation-journal'
import type { Logger } from '../logger'
import { DataRootCleanupJournal } from './data-root-cleanup'

// Writes a verified staging marker for `<parent>/OpenScience`, as a completed copy phase would have.
const seedVerifiedMarker = async (
  parent: string,
  source: string,
  overrides: Partial<MigrationMarker> = {}
): Promise<string> => {
  const target = dataRootFor(parent)
  await mkdir(target, { recursive: true })
  const inventory = await scanInventory(source, [...MIGRATED_DIRS])
  await writeMigrationMarker(target, {
    version: 1,
    token: 'tok-test',
    source,
    target,
    createdAt: Date.now(),
    status: 'verified',
    inventory,
    ...overrides
  })
  return target
}

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

  it('rejects a linked parent whose derived target resolves inside the current data root', async () => {
    const nestedParent = join(currentDataRoot, 'nested-parent')
    const linkedParent = join(emptyParent, 'linked-parent')
    await mkdir(nestedParent, { recursive: true })
    await symlink(nestedParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir')

    const result = await classifyDataRoot(linkedParent, currentDataRoot)

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

  it('rejects a Windows network data root before migration or adoption', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    try {
      const result = await classifyDataRoot(emptyParent, currentDataRoot, {
        inspectPath: async () => ({ isRemote: true, supportsHardLinks: true })
      })

      expect(result).toEqual({
        kind: 'invalid',
        error:
          'Network folders are not supported as the Open Science data location on Windows. Choose a folder on a local drive.'
      })
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('rejects a Windows data root on a local filesystem without hard-link support', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    try {
      const result = await classifyDataRoot(emptyParent, currentDataRoot, {
        inspectPath: async () => ({ isRemote: false, supportsHardLinks: false })
      })

      expect(result).toEqual({
        kind: 'invalid',
        error:
          "This drive's file system does not support safe atomic publication on Windows. Choose a folder on a drive that supports hard links, such as NTFS."
      })
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('rejects an existing derived data root that resolves to remote storage', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const target = dataRootFor(emptyParent)
    await mkdir(target)
    const inspectPath = vi.fn(async (path: string) => ({
      isRemote: path === target,
      supportsHardLinks: true
    }))

    try {
      const result = await classifyDataRoot(emptyParent, currentDataRoot, { inspectPath })

      expect(result).toEqual({
        kind: 'invalid',
        error:
          'Network folders are not supported as the Open Science data location on Windows. Choose a folder on a local drive.'
      })
      expect(inspectPath).toHaveBeenNthCalledWith(1, emptyParent)
      expect(inspectPath).toHaveBeenNthCalledWith(2, target)
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
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

  it('rejects an exact 260-character deepest managed-env path', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    try {
      // Derived target length is 106; the short default env reserve is 154
      // (runtime\envs\.p + separator + the 138 conservative pack budget), totaling exactly 260.
      const result = await classifyDataRoot(`/${'b'.repeat(93)}`, currentDataRoot)

      expect(result.kind).toBe('invalid')
      expect(result.error).toMatch(/too long|260/i)
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('uses the short physical default prefix rather than either logical default name', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    try {
      // Derived target length is 96. The logical default-python reserve would total 262 and reject
      // this target, while the physical .p reserve totals 250 and fits. The synthetic directory does
      // not exist, but it must get past the path-budget check.
      const result = await classifyDataRoot(`/${'b'.repeat(83)}`, currentDataRoot)

      expect(result.kind).toBe('invalid')
      expect(result.error).not.toMatch(/too long|260/i)
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('uses persisted pack metadata at the Windows migration path boundary', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const budgetDir = join(currentDataRoot, 'runtime', 'packs', '1', 'win-64', 'r-4.4')
    await mkdir(budgetDir, { recursive: true })
    await writeFile(
      join(budgetDir, 'path-budget.json'),
      JSON.stringify({ maxCacheRelativePath: 200, maxEnvRelativePath: 160 })
    )

    try {
      // This target fit the old hard-coded 110 reserve, but not the installed pack's 160 budget.
      const result = await classifyDataRoot(`/${'a'.repeat(100)}`, currentDataRoot)

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
  it('classifies a verified marker-bearing staging dir as recoverable, never adoptable', async () => {
    // A crashed/uncommitted copy carries a marker and may hold user data; recovery must still pass
    // through the commit gate rather than silently adopting the snapshot.
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
    await mkdir(join(target, 'artifacts'), { recursive: true })

    const result = await classifyDataRoot(emptyParent, currentDataRoot)

    expect(result).toMatchObject({ kind: 'recover', recoveryStatus: 'verified' })
  })

  it('classifies an interrupted copying marker as discard-only recovery', async () => {
    await seedVerifiedMarker(emptyParent, currentDataRoot, { status: 'copying' })

    const result = await classifyDataRoot(emptyParent, currentDataRoot)

    expect(result).toMatchObject({ kind: 'recover', recoveryStatus: 'copying' })
  })

  it('keeps a marker for another source invalid', async () => {
    await seedVerifiedMarker(emptyParent, join(currentDataRoot, 'other'))

    const result = await classifyDataRoot(emptyParent, currentDataRoot)

    expect(result.kind).toBe('invalid')
  })

  it('keeps a corrupt marker invalid instead of offering destructive recovery', async () => {
    const target = dataRootFor(emptyParent)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, MIGRATION_MARKER_FILENAME), '{not-json')

    const result = await classifyDataRoot(emptyParent, currentDataRoot)

    expect(result.kind).toBe('invalid')
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

  it('rejects a recoverable marker as a new copy target', async () => {
    await seedVerifiedMarker(emptyParent, currentDataRoot)

    const result = await validateNewDataRoot(emptyParent, currentDataRoot)

    expect(result).toEqual({
      ok: false,
      error:
        'This folder holds an unfinished data move. Finish or discard that move before using it here.'
    })
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
  notebook: { shutdownAll: Mock<() => Promise<{ reaped: boolean } | void>> }
  cleanupRuntimeCache: Mock<(runtimeRoot: string) => boolean>
  setDataRoot: Mock<(path: string) => Promise<void>>
}

// Fresh, independently-controllable fake deps for each test.
const fakeDeps = (): FakeDeps => ({
  currentDataRoot,
  runtime: { disconnect: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined) },
  notebook: {
    shutdownAll: vi.fn<() => Promise<{ reaped: boolean } | void>>().mockResolvedValue(undefined)
  },
  cleanupRuntimeCache: vi.fn<(runtimeRoot: string) => boolean>().mockReturnValue(true),
  setDataRoot: vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
})

const runOpts = (): { signal: AbortSignal; onProgress: (p: MigrationProgress) => void } => ({
  signal: new AbortController().signal,
  onProgress: () => {}
})

const fakeDiagnosticLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
})

const diagnosticRecords = (logger: Logger): Record<string, unknown>[] =>
  [logger.debug, logger.info, logger.warn, logger.error].flatMap((method) =>
    (method as Mock).mock.calls.map((call) => call[1] as Record<string, unknown>)
  )

type DeleteResult = { deleted: string[]; failed: { dir: string; error: string }[] }

describe('runDataRootMigration (copy phase)', () => {
  it('diagnoses target validation failure without changing the result or retaining sensitive values', async () => {
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()

    const result = await runDataRootMigration(
      { ...deps, currentDataRoot, logger },
      currentParent,
      runOpts()
    )

    const validationError = 'The new location is the same as the current one.'
    expect(result).toEqual({
      ok: false,
      error: validationError
    })
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-copy',
        phase: 'validate-target',
        outcome: 'failed',
        errorCategory: 'error'
      })
    )
    const serializedDiagnostics = JSON.stringify(diagnosticRecords(logger))
    expect(serializedDiagnostics).not.toContain(currentDataRoot)
    expect(serializedDiagnostics).not.toContain(currentParent)
    expect(serializedDiagnostics).not.toContain(validationError)
  })

  it('rechecks the canonical target after preparation before writing into it', async () => {
    const deps = fakeDeps()
    const target = dataRootFor(emptyParent)
    const redirectedTarget = join(currentDataRoot, 'redirected-target')
    await mkdir(redirectedTarget, { recursive: true })
    deps.cleanupRuntimeCache.mockImplementation(() => {
      symlinkSync(redirectedTarget, target, process.platform === 'win32' ? 'junction' : 'dir')
      return true
    })
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))

    const result = await runDataRootMigration(
      {
        ...deps,
        currentDataRoot,
        copyAndVerify,
        validateProvenanceState: async () => undefined
      },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({
      ok: false,
      error: 'Choose a location outside the current data folder.'
    })
    expect(copyAndVerify).not.toHaveBeenCalled()
    expect(await readMigrationMarker(redirectedTarget)).toBeNull()
  })

  it('records the successful copy lifecycle through staging verification', async () => {
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))

    const result = await runDataRootMigration(
      { ...deps, currentDataRoot, copyAndVerify, logger },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({ ok: true })
    expect(deps.cleanupRuntimeCache).toHaveBeenCalledWith(join(dataRootFor(emptyParent), 'runtime'))
    const records = diagnosticRecords(logger)
    expect(
      records.filter((record) => record.phase && !record.outcome).map((record) => record.phase)
    ).toEqual([
      'validate-target',
      'prepare-staging',
      'pause-writers',
      'validate-source',
      'preserve-runtime',
      'copy',
      'verify-target'
    ])
    expect(records).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-copy',
        phase: 'verify-target',
        outcome: 'completed',
        preservedEnvironmentCount: 0
      })
    )
  })

  it('refuses a runtime-only target whose Notebook cache cannot be safely replaced', async () => {
    const deps = fakeDeps()
    deps.cleanupRuntimeCache.mockReturnValue(false)
    const target = dataRootFor(emptyParent)
    await mkdir(join(target, 'runtime', 'cache', 'notebook'), { recursive: true })
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))

    const result = await runDataRootMigration(
      { ...deps, currentDataRoot, copyAndVerify },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({
      ok: false,
      error:
        'The new data location contains a Notebook cache that Open Science cannot safely replace. Choose another location or remove that cache first.'
    })
    expect(deps.cleanupRuntimeCache).toHaveBeenCalledWith(join(target, 'runtime'))
    expect(copyAndVerify).not.toHaveBeenCalled()
    expect(existsSync(target)).toBe(true)
  })

  it('records bounded copy quartiles without retaining the current file path', async () => {
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const onProgress = vi.fn()
    const copyAndVerify = vi.fn(
      async (opts: { onProgress: (progress: MigrationProgress) => void }) => {
        opts.onProgress({ phase: 'scan', copiedBytes: 0, totalBytes: 400 })
        opts.onProgress({
          phase: 'copy',
          copiedBytes: 110,
          totalBytes: 400,
          currentPath: 'secret/project-name.txt'
        })
        opts.onProgress({ phase: 'copy', copiedBytes: 400, totalBytes: 400 })
        return { ok: true } as const
      }
    )

    await runDataRootMigration({ ...deps, currentDataRoot, copyAndVerify, logger }, emptyParent, {
      ...runOpts(),
      onProgress
    })

    expect(onProgress).toHaveBeenCalledTimes(3)
    expect(
      diagnosticRecords(logger)
        .filter((record) => record.progressPercent !== undefined)
        .map((record) => record.progressPercent)
    ).toEqual([0, 25, 50, 75, 100])
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain('secret/project-name.txt')
  })

  it.skipIf(process.platform === 'win32')(
    'diagnoses staging preparation failure without retaining the target path',
    async () => {
      const deps = fakeDeps()
      const logger = fakeDiagnosticLogger()
      const target = dataRootFor(emptyParent)
      await mkdir(join(target, 'runtime'), { recursive: true })
      await chmod(target, 0o500)

      try {
        const result = await runDataRootMigration(
          { ...deps, currentDataRoot, logger },
          emptyParent,
          runOpts()
        )

        expect(result).toEqual({
          ok: false,
          error: 'Could not prepare the new data location. Please try again.'
        })
        expect(diagnosticRecords(logger)).toContainEqual(
          expect.objectContaining({
            operation: 'data-root-copy',
            phase: 'prepare-staging',
            outcome: 'failed'
          })
        )
        expect(JSON.stringify(diagnosticRecords(logger))).not.toContain(target)
      } finally {
        if (existsSync(target)) await chmod(target, 0o700)
      }
    }
  )

  it('interrupts sessions then copies+verifies into the target, committing nothing', async () => {
    const order: string[] = []
    const deps = fakeDeps()
    deps.runtime.disconnect.mockImplementation(async () => {
      order.push('disconnect')
    })
    deps.notebook.shutdownAll.mockImplementation(async () => {
      order.push('shutdownAll')
    })
    const disconnectProjectDb = vi.fn(async () => {
      order.push('disconnectProjectDb')
    })
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => {
      order.push('copyAndVerify')
      return { ok: true }
    })

    const target = dataRootFor(emptyParent)
    const result = await runDataRootMigration(
      {
        currentDataRoot,
        runtime: deps.runtime,
        notebook: deps.notebook,
        disconnectProjectDb,
        copyAndVerify
      },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({ ok: true })
    // Copy phase commits nothing: interrupt -> copy, and that's it. No setDataRoot, no delete.
    expect(order).toEqual(['disconnect', 'shutdownAll', 'disconnectProjectDb', 'copyAndVerify'])
    expect(copyAndVerify).toHaveBeenCalledWith(
      expect.objectContaining({
        from: currentDataRoot,
        to: target,
        dirs: [
          ...MIGRATED_DIRS,
          RUNTIME_ENVIRONMENT_MANIFESTS_DIR,
          RUNTIME_REPAIR_REGISTRY_FILE,
          join('runtime', 'pkgs')
        ]
      })
    )
    expect(copyAndVerify).toHaveBeenCalledWith(
      expect.objectContaining({ dirs: expect.arrayContaining(['compute']) })
    )
    // runtime/ is excluded wholesale; only relocatable durable subtrees are copied explicitly.
    expect(MIGRATED_DIRS).not.toContain('runtime')
    expect(MIGRATED_DIRS).toContain('delegation')
    expect(MIGRATED_DIRS).toContain('execution-file-evidence')
    expect(MIGRATED_DIRS).toContain('notebook-file-evidence')
    expect(MIGRATED_DIRS).toContain('workspaces')
    expect(DATA_ROOT_DIRS).toContain('runtime')
    expect(DATA_ROOT_DIRS).toContain('delegation')
    expect(DATA_ROOT_DIRS).toContain('execution-file-evidence')
    expect(DATA_ROOT_DIRS).not.toContain('notebook-file-evidence')
    expect(DATA_ROOT_DIRS).toContain('workspaces')
    expect(deps.setDataRoot).not.toHaveBeenCalled()
  })

  it('waits for data-root writers that were already active before starting the copy', async () => {
    let releaseWrite: (() => void) | undefined
    const activeWrite = withDataRootWrite(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve
        })
    )
    const deps = fakeDeps()
    let reportCopyStarted: (() => void) | undefined
    const copyStarted = new Promise<void>((resolve) => {
      reportCopyStarted = resolve
    })
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => {
      reportCopyStarted?.()
      return { ok: true }
    })

    const migrationPromise = runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify },
      emptyParent,
      runOpts()
    )
    const startedBeforeDrain = await Promise.race([
      copyStarted.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100))
    ])
    expect(startedBeforeDrain).toBe(false)
    expect(copyAndVerify).not.toHaveBeenCalled()

    releaseWrite?.()
    await activeWrite
    await migrationPromise
    expect(copyAndVerify).toHaveBeenCalledTimes(1)
  })

  it('returns the copy failure untouched', async () => {
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: false, error: 'x' }))

    const result = await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify, logger },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({ ok: false, error: 'x' })
    expect(deps.setDataRoot).not.toHaveBeenCalled()
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-copy',
        phase: 'copy',
        outcome: 'failed',
        errorCategory: 'error'
      })
    )
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain('"x"')
  })

  it('diagnoses an unexpected copy engine rejection without exposing its error', async () => {
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => {
      throw new Error('copy-secret')
    })

    const result = await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify, logger },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({ ok: false, error: 'Could not copy your data. Please try again.' })
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-copy',
        phase: 'copy',
        outcome: 'failed',
        errorCategory: 'error'
      })
    )
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain('copy-secret')
  })

  it('refuses to stage a migration when the frozen source has unresolved durable provenance', async () => {
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))
    const validateProvenanceState = vi.fn(async () => {
      throw new Error('unfinished Artifact staging')
    })

    const result = await runDataRootMigration(
      {
        currentDataRoot,
        runtime: deps.runtime,
        notebook: deps.notebook,
        copyAndVerify,
        validateProvenanceState,
        logger
      },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({
      ok: false,
      error: 'Could not verify provenance data: unfinished Artifact staging'
    })
    expect(validateProvenanceState).toHaveBeenCalledWith(currentDataRoot)
    expect(copyAndVerify).not.toHaveBeenCalled()
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-copy',
        phase: 'validate-source',
        outcome: 'failed',
        errorCategory: 'error'
      })
    )
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain('unfinished Artifact staging')
  })

  it('diagnoses target provenance verification failure without retaining its error', async () => {
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))
    let validationCount = 0
    const validateProvenanceState = vi.fn(async () => {
      validationCount += 1
      if (validationCount === 2) throw new Error('target-provenance-secret')
    })

    const result = await runDataRootMigration(
      {
        currentDataRoot,
        runtime: deps.runtime,
        notebook: deps.notebook,
        copyAndVerify,
        validateProvenanceState,
        logger
      },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({
      ok: false,
      error: 'Could not verify provenance data: target-provenance-secret'
    })
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-copy',
        phase: 'verify-target',
        outcome: 'failed',
        errorCategory: 'error'
      })
    )
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain('target-provenance-secret')
  })

  it('refuses to copy while the source runtime recovery journal has a pending operation', async () => {
    const deps = fakeDeps()
    const runtimeRoot = join(currentDataRoot, 'runtime')
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'operation-installing',
      kind: 'install',
      runtimeId: 'default-python',
      phase: 'install-python',
      startedAt: Date.now(),
      targetPath: join(runtimeRoot, 'envs', 'default-python')
    })
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))

    const result = await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({
      ok: false,
      error:
        'Could not verify provenance data: Unfinished Runtime operation blocks migration: operation-installing'
    })
    expect(copyAndVerify).not.toHaveBeenCalled()
  })

  it('moves immutable Environment manifests and runtime quarantine without dirty inventory', async () => {
    const deps = fakeDeps()
    const environmentKey = '6781bee2cc7128dad60abe39756695758edd2dc2f9b42bb53db430253a7d8b43'
    const inventoryTarget = join(
      currentDataRoot,
      'runtime',
      'provenance',
      'environment-inventory',
      environmentKey
    )
    await mkdir(join(inventoryTarget, 'operations'), { recursive: true })
    await writeFile(
      join(inventoryTarget, 'binding.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        state: 'dirty',
        dirtyOperationId: 'operation-interrupted',
        dirtyReason: 'recovery',
        operationLog: []
      })
    )
    await writeFile(join(inventoryTarget, 'operations', 'operation-interrupted.json'), '{}')

    const manifestName = `${'a'.repeat(64)}.json`
    const sourceManifest = join(currentDataRoot, RUNTIME_ENVIRONMENT_MANIFESTS_DIR, manifestName)
    await mkdir(join(currentDataRoot, RUNTIME_ENVIRONMENT_MANIFESTS_DIR), { recursive: true })
    await writeFile(sourceManifest, '{"schemaVersion":1}\n')
    const repairRegistry = {
      runtimeIds: ['managed:python:default-python'],
      reasons: { 'managed:python:default-python': 'interrupted-install' }
    }
    await writeFile(
      join(currentDataRoot, RUNTIME_REPAIR_REGISTRY_FILE),
      `${JSON.stringify(repairRegistry)}\n`
    )

    const target = dataRootFor(emptyParent)
    const destinationInventory = join(
      target,
      'runtime',
      'provenance',
      'environment-inventory',
      'stale-environment'
    )
    await mkdir(destinationInventory, { recursive: true })
    await writeFile(join(destinationInventory, 'binding.json'), '{"state":"dirty"}\n')
    const result = await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({ ok: true })
    expect(existsSync(join(target, RUNTIME_ENVIRONMENT_MANIFESTS_DIR, manifestName))).toBe(true)
    await expect(readFile(join(target, RUNTIME_REPAIR_REGISTRY_FILE), 'utf8')).resolves.toBe(
      `${JSON.stringify(repairRegistry)}\n`
    )
    expect(existsSync(join(target, 'runtime', 'provenance', 'environment-inventory'))).toBe(false)
  })

  it('refuses and preserves a target containing durable runtime archives', async () => {
    const deps = fakeDeps()
    const target = dataRootFor(emptyParent)
    const archive = join(target, 'runtime', 'pkgs', 'preserve.conda')
    await mkdir(join(target, 'runtime', 'pkgs'), { recursive: true })
    await writeFile(archive, 'existing archive')
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))

    const result = await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({
      ok: false,
      error:
        'The new data location contains runtime data that Open Science cannot safely replace. Choose another location or remove that data first.'
    })
    expect(copyAndVerify).not.toHaveBeenCalled()
    expect(deps.runtime.disconnect).not.toHaveBeenCalled()
    expect(deps.notebook.shutdownAll).not.toHaveBeenCalled()
    expect(await readFile(archive, 'utf8')).toBe('existing archive')
    expect(await readMigrationMarker(target)).toBeNull()
  })

  it('refuses a linked target runtime without touching its contents', async () => {
    const deps = fakeDeps()
    const target = dataRootFor(emptyParent)
    const foreignRuntime = join(emptyParent, 'foreign-runtime')
    const foreignInventory = join(
      foreignRuntime,
      'provenance',
      'environment-inventory',
      'binding.json'
    )
    await mkdir(join(target), { recursive: true })
    await mkdir(join(foreignRuntime, 'provenance', 'environment-inventory'), { recursive: true })
    await writeFile(foreignInventory, 'foreign inventory')
    await symlink(
      foreignRuntime,
      join(target, 'runtime'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))

    const result = await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify },
      emptyParent,
      runOpts()
    )

    expect(result.ok).toBe(false)
    expect(copyAndVerify).not.toHaveBeenCalled()
    expect(deps.cleanupRuntimeCache).not.toHaveBeenCalled()
    expect(await readFile(foreignInventory, 'utf8')).toBe('foreign inventory')
    expect(existsSync(join(target, 'runtime'))).toBe(true)
  })

  it("stamps a 'copying' marker before the copy and promotes it to 'verified' on success", async () => {
    const deps = fakeDeps()
    const target = dataRootFor(emptyParent)
    let statusDuringCopy: string | undefined
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => {
      // The marker must already read 'copying' while bytes are being written.
      statusDuringCopy = (await readMigrationMarker(target))?.status
      return { ok: true }
    })

    await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify },
      emptyParent,
      runOpts()
    )

    expect(statusDuringCopy).toBe('copying')
    const finalMarker = await readMigrationMarker(target)
    expect(finalMarker).toMatchObject({
      status: 'verified',
      source: currentDataRoot,
      target,
      version: 1
    })
    // The verified marker records the staged inventory (empty here since the fake copy wrote nothing).
    expect(finalMarker?.inventory).toEqual({
      dirs: [],
      fileCount: 0,
      totalBytes: 0,
      digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    })
  })

  it('diagnoses staged-copy finalization failure without retaining callback error details', async () => {
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))

    const result = await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify, logger },
      emptyParent,
      {
        signal: new AbortController().signal,
        onProgress: () => {},
        onVerified: () => {
          throw new Error('verification-callback-secret')
        }
      }
    )

    expect(result).toEqual({
      ok: false,
      error: 'Could not finalize the copied data. Please run the move again.'
    })
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-copy',
        phase: 'verify-target',
        outcome: 'failed',
        errorCategory: 'error'
      })
    )
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain('verification-callback-secret')
  })

  it.skipIf(process.platform === 'win32')(
    'diagnoses staged inventory failure at target verification',
    async () => {
      const deps = fakeDeps()
      const logger = fakeDiagnosticLogger()
      const target = dataRootFor(emptyParent)
      const unreadableDir = join(target, 'artifacts')
      const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => {
        await mkdir(unreadableDir, { recursive: true })
        await writeFile(join(unreadableDir, 'private.txt'), 'private')
        await chmod(unreadableDir, 0o000)
        return { ok: true }
      })

      try {
        const result = await runDataRootMigration(
          {
            currentDataRoot,
            runtime: deps.runtime,
            notebook: deps.notebook,
            copyAndVerify,
            validateProvenanceState: async () => undefined,
            logger
          },
          emptyParent,
          runOpts()
        )

        expect(result).toEqual({
          ok: false,
          error: 'Could not verify the copied data. Please run the move again.'
        })
        expect(diagnosticRecords(logger)).toContainEqual(
          expect.objectContaining({
            operation: 'data-root-copy',
            phase: 'verify-target',
            outcome: 'failed'
          })
        )
      } finally {
        if (existsSync(unreadableDir)) await chmod(unreadableDir, 0o700)
      }
    }
  )

  it('removes the marker and cleans up the empty target on copy failure/cancel', async () => {
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const target = dataRootFor(emptyParent)
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({
      ok: false,
      error: 'x',
      cancelled: true
    }))

    await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify, logger },
      emptyParent,
      runOpts()
    )

    // No marker, and the empty staging shell is gone — a cancelled move leaves no trace.
    expect(await readMigrationMarker(target)).toBeNull()
    expect(existsSync(target)).toBe(false)
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-copy',
        phase: 'copy',
        outcome: 'cancelled',
        cancelRequested: true
      })
    )
  })

  it('records cancellation requested while the copy engine is finishing as cancelled', async () => {
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const controller = new AbortController()
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => {
      controller.abort()
      return { ok: true }
    })

    const result = await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify, logger },
      emptyParent,
      { signal: controller.signal, onProgress: () => {} }
    )

    expect(result).toEqual({ ok: false, error: 'migration cancelled', cancelled: true })
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-copy',
        phase: 'copy',
        outcome: 'cancelled',
        cancelRequested: true
      })
    )
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

  it('aborts (and does not copy) when a writer cannot be paused', async () => {
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    deps.runtime.disconnect.mockRejectedValue(new Error('disconnect boom'))
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))

    const result = await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify, logger },
      emptyParent,
      runOpts()
    )

    expect(result.ok).toBe(false)
    // Copying an unfrozen tree could lose a surviving write on the commit's delete, so we never start.
    expect(copyAndVerify).not.toHaveBeenCalled()
    // The staging dir (marker) we created is cleaned up on abort.
    expect(existsSync(dataRootFor(emptyParent))).toBe(false)
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-copy',
        phase: 'pause-writers',
        outcome: 'failed',
        errorCategory: 'error'
      })
    )
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain('disconnect boom')
  })

  it('aborts before copying when a Notebook child cannot be reaped', async () => {
    const deps = fakeDeps()
    deps.notebook.shutdownAll.mockResolvedValue({ reaped: false })
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))

    const result = await runDataRootMigration(
      { currentDataRoot, runtime: deps.runtime, notebook: deps.notebook, copyAndVerify },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({
      ok: false,
      error: 'Could not pause running work to copy your data safely. Please try again in a moment.'
    })
    expect(copyAndVerify).not.toHaveBeenCalled()
    expect(existsSync(dataRootFor(emptyParent))).toBe(false)
  })
})

describe('commitDataRootSwitch (commit phase)', () => {
  it('rejects an older verified marker that omits a newly registered data directory', async () => {
    const cacheFile = join(
      currentDataRoot,
      'compute',
      'session-cache',
      'project-1',
      'session-1',
      'result.csv'
    )
    await mkdir(dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, 'retained')
    const olderDirs = MIGRATED_DIRS.filter((directory) => directory !== 'compute')
    await seedVerifiedMarker(emptyParent, currentDataRoot, {
      migratedDirs: olderDirs,
      inventory: await scanInventory(currentDataRoot, olderDirs)
    })
    const setDataRoot = vi.fn(async () => undefined)

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot,
        expectedToken: 'tok-test',
        validateProvenanceState: async () => undefined
      },
      emptyParent
    )

    expect(result).toEqual({
      ok: false,
      error: 'The staged copy does not include all current data. Run the move again.'
    })
    expect(setDataRoot).not.toHaveBeenCalled()
    await expect(readFile(cacheFile, 'utf8')).resolves.toBe('retained')
  })

  it('commits an empty migration with cleanup journaling when the source root is missing', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
    await rm(currentDataRoot, { recursive: true, force: true })
    const cleanupJournal = new DataRootCleanupJournal(join(emptyParent, 'config'))
    const setDataRoot = vi.fn().mockResolvedValue(undefined)

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot,
        cleanupJournal,
        expectedToken: 'tok-test',
        validateProvenanceState: async () => undefined
      },
      emptyParent
    )

    expect(result).toEqual({ ok: true })
    expect(setDataRoot).toHaveBeenCalledWith(target)
    await expect(cleanupJournal.hasPending()).resolves.toBe(false)
    await expect(readMigrationMarker(target)).resolves.toBeNull()
  })

  it('commits and cleans a migrated runtime quarantine through the durable cleanup journal', async () => {
    const sourceRegistry = join(currentDataRoot, RUNTIME_REPAIR_REGISTRY_FILE)
    const contents =
      '{"runtimeIds":["managed:python:default-python"],"reasons":{"managed:python:default-python":"interrupted-install"}}\n'
    await mkdir(dirname(sourceRegistry), { recursive: true })
    await writeFile(sourceRegistry, contents)

    let token = ''
    const copyResult = await runDataRootMigration(
      {
        ...fakeDeps(),
        currentDataRoot,
        validateProvenanceState: async () => undefined
      },
      emptyParent,
      {
        ...runOpts(),
        onVerified: (staged) => {
          token = staged.token
        }
      }
    )
    expect(copyResult).toEqual({ ok: true })

    const target = dataRootFor(emptyParent)
    const cleanupJournal = new DataRootCleanupJournal(join(emptyParent, 'config'))
    const setDataRoot = vi.fn(async () => undefined)
    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot,
        cleanupJournal,
        expectedToken: token,
        validateProvenanceState: async () => undefined
      },
      emptyParent
    )

    expect(result).toEqual({ ok: true })
    expect(setDataRoot).toHaveBeenCalledWith(target)
    await expect(readFile(join(target, RUNTIME_REPAIR_REGISTRY_FILE), 'utf8')).resolves.toBe(
      contents
    )
    expect(existsSync(sourceRegistry)).toBe(false)
    await expect(cleanupJournal.hasPending()).resolves.toBe(false)
  })

  it('preserves timestamps after target verification and the commit-time recheck', async () => {
    const sourceFile = join(currentDataRoot, 'artifacts', 'observations.csv')
    await mkdir(join(currentDataRoot, 'artifacts'), { recursive: true })
    await writeFile(sourceFile, 'time,value\n1,42\n')
    const originalAtime = new Date('2001-02-03T04:05:06.000Z')
    const originalMtime = new Date('2002-03-04T05:06:07.000Z')
    await utimes(sourceFile, originalAtime, originalMtime)

    const readMigratedFile = async (root: string): Promise<void> => {
      const file = join(root, 'artifacts', 'observations.csv')
      if (existsSync(file)) await readFile(file)
    }
    let markerToken = ''
    const copyResult = await runDataRootMigration(
      {
        ...fakeDeps(),
        currentDataRoot,
        validateProvenanceState: readMigratedFile
      },
      emptyParent,
      {
        ...runOpts(),
        onVerified: ({ token }) => {
          markerToken = token
        }
      }
    )
    expect(copyResult).toEqual({ ok: true })

    const target = dataRootFor(emptyParent)
    const commitResult = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot: vi.fn().mockResolvedValue(undefined),
        deleteSources: async () => ({ deleted: [], failed: [] }),
        expectedToken: markerToken,
        validateProvenanceState: readMigratedFile
      },
      emptyParent
    )

    expect(commitResult).toEqual({ ok: true })
    const copiedFile = await stat(join(target, 'artifacts', 'observations.csv'))
    expect(Math.trunc(copiedFile.atimeMs / 1000)).toBe(Math.trunc(originalAtime.getTime() / 1000))
    expect(Math.trunc(copiedFile.mtimeMs / 1000)).toBe(Math.trunc(originalMtime.getTime() / 1000))
  })

  it('never completes a move that strands an absolute link into the old data root', async () => {
    const sourceDirectory = join(currentDataRoot, 'artifacts', 'source-directory')
    const sourceLink = join(currentDataRoot, 'artifacts', 'absolute-link')
    await mkdir(sourceDirectory, { recursive: true })
    await writeFile(join(sourceDirectory, 'result.txt'), 'preserved content')
    await symlink(sourceDirectory, sourceLink, process.platform === 'win32' ? 'junction' : 'dir')
    const copyAndVerify = vi.fn(async ({ to }: { to: string }): Promise<MigrationResult> => {
      const copiedDirectory = join(to, 'artifacts', 'source-directory')
      await mkdir(copiedDirectory, { recursive: true })
      await writeFile(join(copiedDirectory, 'result.txt'), 'preserved content')
      await symlink(
        sourceDirectory,
        join(to, 'artifacts', 'absolute-link'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      return { ok: true }
    })

    const copyResult = await runDataRootMigration(
      {
        ...fakeDeps(),
        currentDataRoot,
        copyAndVerify,
        validateProvenanceState: async () => undefined
      },
      emptyParent,
      runOpts()
    )
    if (!copyResult.ok) {
      expect(copyResult.error).toMatch(/absolute symbolic link.*current data folder/i)
      await expect(readFile(join(sourceLink, 'result.txt'), 'utf8')).resolves.toBe(
        'preserved content'
      )
      return
    }

    const target = dataRootFor(emptyParent)
    const marker = await readMigrationMarker(target)
    const commitResult = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot: vi.fn().mockResolvedValue(undefined),
        expectedToken: marker?.token ?? '',
        validateProvenanceState: async () => undefined
      },
      emptyParent
    )

    expect(commitResult).toEqual({ ok: true })
    await expect(
      readFile(join(target, 'artifacts', 'absolute-link', 'result.txt'), 'utf8')
    ).resolves.toBe('preserved content')
  })

  it('refuses a recovered verified copy whose absolute link still targets the old data root', async () => {
    const sourceDirectory = join(currentDataRoot, 'artifacts', 'source-directory')
    await mkdir(sourceDirectory, { recursive: true })
    await writeFile(join(sourceDirectory, 'result.txt'), 'preserved content')
    await symlink(
      sourceDirectory,
      join(currentDataRoot, 'artifacts', 'absolute-link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const target = dataRootFor(emptyParent)
    const copiedDirectory = join(target, 'artifacts', 'source-directory')
    await mkdir(copiedDirectory, { recursive: true })
    await writeFile(join(copiedDirectory, 'result.txt'), 'preserved content')
    await symlink(
      sourceDirectory,
      join(target, 'artifacts', 'absolute-link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await seedVerifiedMarker(emptyParent, currentDataRoot, {
      inventory: await scanInventory(target, [...MIGRATED_DIRS])
    })
    const setDataRoot = vi.fn().mockResolvedValue(undefined)
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({
      deleted: [],
      failed: []
    }))

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot,
        deleteSources,
        expectedToken: 'tok-test',
        validateProvenanceState: async () => undefined
      },
      emptyParent
    )

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringMatching(/absolute symbolic link/i)
      })
    )
    expect(setDataRoot).not.toHaveBeenCalled()
    expect(deleteSources).not.toHaveBeenCalled()
    await expect(readFile(join(sourceDirectory, 'result.txt'), 'utf8')).resolves.toBe(
      'preserved content'
    )
  })

  it('correlates distinct copy and commit operations without reusing the marker token', async () => {
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const diagnosticCorrelationId = 'diagnostic-migration-id'
    let markerToken = ''

    await runDataRootMigration(
      {
        currentDataRoot,
        runtime: deps.runtime,
        notebook: deps.notebook,
        copyAndVerify: async () => ({ ok: true }),
        validateProvenanceState: async () => undefined,
        logger,
        diagnosticCorrelationId
      },
      emptyParent,
      {
        ...runOpts(),
        onVerified: ({ token }) => {
          markerToken = token
        }
      }
    )

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot: deps.setDataRoot,
        deleteSources: async () => ({ deleted: [], failed: [] }),
        validateProvenanceState: async () => undefined,
        expectedToken: markerToken,
        logger,
        diagnosticCorrelationId
      },
      emptyParent
    )

    expect(result).toEqual({ ok: true })
    const terminalRecords = diagnosticRecords(logger).filter(
      (record) => record.outcome === 'completed'
    )
    expect(terminalRecords).toHaveLength(2)
    expect(terminalRecords.map((record) => record.operation)).toEqual([
      'data-root-copy',
      'data-root-commit'
    ])
    expect(
      terminalRecords.every((record) => record.correlationId === diagnosticCorrelationId)
    ).toBe(true)
    expect(new Set(terminalRecords.map((record) => record.operationId)).size).toBe(2)
    expect(markerToken).not.toBe(diagnosticCorrelationId)
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain(markerToken)
  })

  it('keeps the fixed config-root SQLite authority out of the relocatable data set', async () => {
    const deps = fakeDeps()
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))

    await runDataRootMigration(
      { ...deps, currentDataRoot, copyAndVerify, validateProvenanceState: async () => undefined },
      emptyParent,
      runOpts()
    )

    expect(copyAndVerify).toHaveBeenCalledWith(
      expect.objectContaining({
        dirs: expect.not.arrayContaining([PROJECT_DATABASE_FILE])
      })
    )
  })

  it('persists the new root then deletes the old dirs, in that order, and removes the marker', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
    const order: string[] = []
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    deps.setDataRoot.mockImplementation(async () => {
      order.push('setDataRoot')
    })
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => {
      order.push('deleteSources')
      return { deleted: [...MIGRATED_DIRS], failed: [] }
    })

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot: deps.setDataRoot,
        deleteSources,
        expectedToken: 'tok-test',
        logger
      },
      emptyParent
    )

    expect(result).toEqual({ ok: true })
    // setDataRoot MUST precede delete: once the pointer is committed, an interrupted delete only
    // orphans the old root; the reverse order could strand data.
    expect(order).toEqual(['setDataRoot', 'deleteSources'])
    expect(deps.setDataRoot).toHaveBeenCalledWith(target)
    expect(deleteSources).toHaveBeenCalledWith(currentDataRoot, [...MIGRATED_DIRS])
    // The committed (now-live) root must carry NO marker.
    expect(existsSync(join(target, MIGRATION_MARKER_FILENAME))).toBe(false)
    const records = diagnosticRecords(logger)
    expect(
      records.filter((record) => record.phase && !record.outcome).map((record) => record.phase)
    ).toEqual(['recheck-inventory', 'validate-provenance', 'persist-pointer', 'cleanup-source'])
    expect(records).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-commit',
        phase: 'cleanup-source',
        outcome: 'completed',
        cleanupDegraded: false,
        cleanupFailureCount: 0
      })
    )
    expect(JSON.stringify(records)).not.toContain(currentDataRoot)
    expect(JSON.stringify(records)).not.toContain(target)
    expect(JSON.stringify(records)).not.toContain('tok-test')
  })

  it('refuses to commit when no marker is present (setDataRoot and delete never run)', async () => {
    await mkdir(dataRootFor(emptyParent), { recursive: true }) // staging dir, but no marker
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] }))

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot: deps.setDataRoot,
        deleteSources,
        expectedToken: 'tok-test',
        logger
      },
      emptyParent
    )

    expect(result).toEqual({ ok: false, error: 'No completed migration copy was found to commit.' })
    expect(deps.setDataRoot).not.toHaveBeenCalled()
    expect(deleteSources).not.toHaveBeenCalled()
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-commit',
        phase: 'recheck-inventory',
        outcome: 'failed',
        errorCategory: 'error'
      })
    )
  })

  it("refuses to commit a marker that is only 'copying' (not verified)", async () => {
    await seedVerifiedMarker(emptyParent, currentDataRoot, { status: 'copying' })
    const deps = fakeDeps()
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] }))

    const result = await commitDataRootSwitch(
      { currentDataRoot, setDataRoot: deps.setDataRoot, deleteSources, expectedToken: 'tok-test' },
      emptyParent
    )

    expect(result).toEqual({ ok: false, error: 'No completed migration copy was found to commit.' })
    expect(deps.setDataRoot).not.toHaveBeenCalled()
    expect(deleteSources).not.toHaveBeenCalled()
  })

  it('refuses to commit a marker staged against a different source (wrong current root)', async () => {
    await seedVerifiedMarker(emptyParent, '/some/other/OpenScience')
    const deps = fakeDeps()
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] }))

    const result = await commitDataRootSwitch(
      { currentDataRoot, setDataRoot: deps.setDataRoot, deleteSources, expectedToken: 'tok-test' },
      emptyParent
    )

    expect(result).toEqual({
      ok: false,
      error: 'The staged copy does not match your current data location.'
    })
    expect(deps.setDataRoot).not.toHaveBeenCalled()
    expect(deleteSources).not.toHaveBeenCalled()
  })

  it('refuses to commit a marker whose recorded target differs from the derived one', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot, {
      target: '/elsewhere/OpenScience'
    })
    const deps = fakeDeps()
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] }))

    const result = await commitDataRootSwitch(
      { currentDataRoot, setDataRoot: deps.setDataRoot, deleteSources, expectedToken: 'tok-test' },
      emptyParent
    )

    expect(result).toEqual({ ok: false, error: 'The staged copy is for a different destination.' })
    expect(deps.setDataRoot).not.toHaveBeenCalled()
    expect(deleteSources).not.toHaveBeenCalled()
    // Marker left intact so the copy stays discardable.
    expect(existsSync(join(target, MIGRATION_MARKER_FILENAME))).toBe(true)
  })

  it('returns switchoverFailed, skips delete, and KEEPS the marker when setDataRoot fails', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    deps.setDataRoot.mockRejectedValue(new Error('disk full'))
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] }))

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot: deps.setDataRoot,
        deleteSources,
        expectedToken: 'tok-test',
        logger
      },
      emptyParent
    )

    expect(result).toEqual({
      ok: false,
      error: `Your data was copied to ${target}, but the app could not finish switching over. Please try again; your current data is untouched.`,
      switchoverFailed: true
    })
    expect(deleteSources).not.toHaveBeenCalled()
    // The copy stays discardable/retryable, so the marker must survive a failed switchover.
    expect(existsSync(join(target, MIGRATION_MARKER_FILENAME))).toBe(true)
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-commit',
        phase: 'persist-pointer',
        outcome: 'failed',
        switchoverFailed: true,
        errorCategory: 'error'
      })
    )
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain('disk full')
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain(target)
  })

  it('diagnoses commit provenance validation failure without retaining its error', async () => {
    await seedVerifiedMarker(emptyParent, currentDataRoot)
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const validateProvenanceState = vi.fn(async () => {
      throw new Error('commit-provenance-secret')
    })

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot: deps.setDataRoot,
        expectedToken: 'tok-test',
        validateProvenanceState,
        logger
      },
      emptyParent
    )

    expect(result).toEqual({
      ok: false,
      error: 'Could not verify provenance data: commit-provenance-secret'
    })
    expect(deps.setDataRoot).not.toHaveBeenCalled()
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-commit',
        phase: 'validate-provenance',
        outcome: 'failed',
        errorCategory: 'error'
      })
    )
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain('commit-provenance-secret')
  })

  it('still succeeds when deleteSources reports per-dir failures (harmless leftovers)', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
    const cleanupJournal = new DataRootCleanupJournal(join(emptyParent, 'config'))
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({
      deleted: ['artifacts'],
      failed: [{ dir: 'uploads', error: 'EACCES' }]
    }))

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot: deps.setDataRoot,
        deleteSources,
        cleanupJournal,
        expectedToken: 'tok-test',
        logger
      },
      emptyParent
    )

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        cleanupWarning: expect.any(String)
      })
    )
    expect(await readMigrationMarker(target)).toMatchObject({
      status: 'verified',
      source: currentDataRoot,
      target
    })
    await expect(cleanupJournal.hasPending()).resolves.toBe(true)
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-commit',
        phase: 'cleanup-source',
        outcome: 'completed',
        cleanupDegraded: true,
        cleanupFailureCount: 1
      })
    )
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain('uploads')
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain('EACCES')
  })

  it('keeps rebuildable cache cleanup failures durable for startup retry', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
    const cleanupJournal = new DataRootCleanupJournal(join(emptyParent, 'config'))
    const cleanupRuntimeCache = vi.fn(async () => false)

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot: vi.fn(async () => {}),
        deleteSources: vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] })),
        cleanupJournal,
        cleanupRuntimeCache,
        expectedToken: 'tok-test'
      },
      emptyParent
    )

    expect(result).toEqual(
      expect.objectContaining({ ok: true, cleanupWarning: expect.any(String) })
    )
    expect(cleanupRuntimeCache).toHaveBeenCalledWith(currentDataRoot)
    await expect(cleanupJournal.hasPending()).resolves.toBe(true)
    await expect(readMigrationMarker(target)).resolves.toMatchObject({ token: 'tok-test' })
  })

  it('defers deleting a root that still proves an earlier cleanup intent', async () => {
    const olderRoot = join(currentParent, 'older-root')
    await mkdir(join(olderRoot, 'artifacts'), { recursive: true })
    await mkdir(join(currentDataRoot, 'artifacts'), { recursive: true })
    await writeFile(join(olderRoot, 'artifacts', 'result.txt'), 'preserved')
    await writeFile(join(currentDataRoot, 'artifacts', 'result.txt'), 'preserved')
    await writeMigrationMarker(currentDataRoot, {
      version: 1,
      token: 'older-token',
      source: olderRoot,
      target: currentDataRoot,
      createdAt: 1,
      status: 'verified',
      migratedDirs: ['artifacts'],
      inventory: await scanInventory(currentDataRoot, ['artifacts'])
    })
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
    await mkdir(join(target, 'artifacts'), { recursive: true })
    await writeFile(join(target, 'artifacts', 'result.txt'), 'preserved')
    await writeMigrationMarker(target, {
      ...(await readMigrationMarker(target))!,
      inventory: await scanInventory(target, [...MIGRATED_DIRS])
    })

    const cleanupJournal = new DataRootCleanupJournal(join(emptyParent, 'config'))
    await cleanupJournal.stage({
      token: 'older-token',
      source: olderRoot,
      target: currentDataRoot,
      dirs: ['artifacts'],
      createdAt: 1
    })
    await cleanupJournal.markCommitted('older-token')
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] }))

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot: vi.fn(async () => {}),
        deleteSources,
        cleanupJournal,
        expectedToken: 'tok-test'
      },
      emptyParent
    )

    expect(result).toEqual({ ok: true })
    expect(deleteSources).not.toHaveBeenCalled()
    await expect(cleanupJournal.hasPending()).resolves.toBe(true)
    await expect(readMigrationMarker(target)).resolves.toMatchObject({ token: 'tok-test' })
    await expect(readFile(join(currentDataRoot, 'artifacts', 'result.txt'), 'utf8')).resolves.toBe(
      'preserved'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'reports marker cleanup failure as degraded success after pointer persistence',
    async () => {
      const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
      const logger = fakeDiagnosticLogger()
      const setDataRoot = vi.fn(async () => {
        await chmod(target, 0o500)
      })
      const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({
        deleted: [...MIGRATED_DIRS],
        failed: []
      }))

      try {
        const result = await commitDataRootSwitch(
          { currentDataRoot, setDataRoot, deleteSources, expectedToken: 'tok-test', logger },
          emptyParent
        )

        expect(result).toEqual({ ok: true })
        expect(diagnosticRecords(logger)).toContainEqual(
          expect.objectContaining({
            operation: 'data-root-commit',
            phase: 'cleanup-source',
            outcome: 'completed',
            cleanupDegraded: true,
            cleanupFailureCount: 0
          })
        )
      } finally {
        await chmod(target, 0o700)
      }
    }
  )

  it('treats an unexpected cleanup rejection as degraded success after pointer persistence', async () => {
    await seedVerifiedMarker(emptyParent, currentDataRoot)
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => {
      throw new Error('cleanup-secret')
    })

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot: deps.setDataRoot,
        deleteSources,
        expectedToken: 'tok-test',
        logger
      },
      emptyParent
    )

    expect(result).toEqual(
      expect.objectContaining({ ok: true, cleanupWarning: expect.any(String) })
    )
    expect(deps.setDataRoot).toHaveBeenCalledOnce()
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-commit',
        phase: 'cleanup-source',
        outcome: 'completed',
        cleanupDegraded: true,
        cleanupFailureCount: 1
      })
    )
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain('cleanup-secret')
  })
  it('refuses when the marker token does not match the session token', async () => {
    await seedVerifiedMarker(emptyParent, currentDataRoot) // token 'tok-test'
    const setDataRoot = vi.fn(async () => {})

    const result = await commitDataRootSwitch(
      { currentDataRoot, setDataRoot, expectedToken: 'a-different-token' },
      emptyParent
    )

    expect(result.ok).toBe(false)
    expect(setDataRoot).not.toHaveBeenCalled()
  })

  it('refuses commit when the current migration session token is missing', async () => {
    await seedVerifiedMarker(emptyParent, currentDataRoot)
    const setDataRoot = vi.fn(async () => {})

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot,
        expectedToken: undefined as unknown as string
      },
      emptyParent
    )

    expect(result.ok).toBe(false)
    expect(setDataRoot).not.toHaveBeenCalled()
  })

  it('refuses a legacy staged marker that omitted existing durable package archives', async () => {
    await mkdir(join(currentDataRoot, 'runtime', 'pkgs'), { recursive: true })
    await writeFile(join(currentDataRoot, 'runtime', 'pkgs', 'archive.conda'), 'durable archive')
    await seedVerifiedMarker(emptyParent, currentDataRoot)
    const setDataRoot = vi.fn(async () => {})
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] }))

    const result = await commitDataRootSwitch(
      { currentDataRoot, setDataRoot, deleteSources, expectedToken: 'tok-test' },
      emptyParent
    )

    expect(result).toEqual({
      ok: false,
      error: 'The staged copy does not include all required provenance data. Run the move again.'
    })
    expect(setDataRoot).not.toHaveBeenCalled()
    expect(deleteSources).not.toHaveBeenCalled()
  })

  it('refuses a legacy staged marker that omitted an existing runtime quarantine', async () => {
    await mkdir(dirname(join(currentDataRoot, RUNTIME_REPAIR_REGISTRY_FILE)), { recursive: true })
    await writeFile(
      join(currentDataRoot, RUNTIME_REPAIR_REGISTRY_FILE),
      '{"runtimeIds":["managed:python:default-python"],"reasons":{}}\n'
    )
    await seedVerifiedMarker(emptyParent, currentDataRoot)
    const setDataRoot = vi.fn(async () => {})
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] }))

    const result = await commitDataRootSwitch(
      { currentDataRoot, setDataRoot, deleteSources, expectedToken: 'tok-test' },
      emptyParent
    )

    expect(result).toEqual({
      ok: false,
      error: 'The staged copy does not include all required provenance data. Run the move again.'
    })
    expect(setDataRoot).not.toHaveBeenCalled()
    expect(deleteSources).not.toHaveBeenCalled()
  })

  it('refuses commit when the verified target inventory has changed', async () => {
    await mkdir(join(currentDataRoot, 'artifacts'), { recursive: true })
    await writeFile(join(currentDataRoot, 'artifacts', 'keep.txt'), 'hello')
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
    await mkdir(join(target, 'artifacts'), { recursive: true })
    await writeFile(join(target, 'artifacts', 'keep.txt'), 'hello')
    await writeFile(join(target, 'artifacts', 'keep.txt'), 'jello')
    const setDataRoot = vi.fn(async () => {})
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({
      deleted: [...MIGRATED_DIRS],
      failed: []
    }))

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot,
        deleteSources,
        expectedToken: 'tok-test'
      },
      emptyParent
    )

    expect(result.ok).toBe(false)
    expect(setDataRoot).not.toHaveBeenCalled()
    expect(deleteSources).not.toHaveBeenCalled()
  })

  it('refuses commit when the source inventory has changed after verification', async () => {
    await mkdir(join(currentDataRoot, 'artifacts'), { recursive: true })
    await writeFile(join(currentDataRoot, 'artifacts', 'keep.txt'), 'hello')
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
    await mkdir(join(target, 'artifacts'), { recursive: true })
    await writeFile(join(target, 'artifacts', 'keep.txt'), 'hello')
    await writeFile(join(currentDataRoot, 'artifacts', 'late.txt'), 'late write')
    const setDataRoot = vi.fn(async () => {})
    const logger = fakeDiagnosticLogger()
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({
      deleted: [...MIGRATED_DIRS],
      failed: []
    }))

    const result = await commitDataRootSwitch(
      {
        currentDataRoot,
        setDataRoot,
        deleteSources,
        expectedToken: 'tok-test',
        logger
      },
      emptyParent
    )

    expect(result).toEqual({
      ok: false,
      error: 'The staged copy changed after verification. Run the move again.'
    })
    expect(setDataRoot).not.toHaveBeenCalled()
    expect(deleteSources).not.toHaveBeenCalled()
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-commit',
        phase: 'recheck-inventory',
        outcome: 'failed',
        errorCategory: 'error'
      })
    )
  })
})

describe('discardStagedCopy', () => {
  it('deletes a marker-confirmed staged copy for the current root', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)

    const result = await discardStagedCopy(
      { currentDataRoot, expectedToken: 'tok-test' },
      emptyParent
    )

    expect(result).toEqual({ ok: true })
    expect(existsSync(target)).toBe(false)
  })

  it('refuses (and deletes nothing) when the derived target is the current data location', async () => {
    // Deriving from currentParent yields currentDataRoot itself.
    const result = await discardStagedCopy(
      { currentDataRoot, expectedToken: 'tok-test' },
      currentParent
    )

    expect(result).toEqual({ ok: false, error: 'Refused: target is the current data location.' })
    expect(existsSync(currentDataRoot)).toBe(true)
  })

  it('refuses when there is no marker at the target', async () => {
    const target = dataRootFor(emptyParent)
    await mkdir(target, { recursive: true })

    const result = await discardStagedCopy(
      { currentDataRoot, expectedToken: 'tok-test' },
      emptyParent
    )

    expect(result).toEqual({ ok: false, error: 'Refused: not a completed, matching staged copy.' })
    expect(existsSync(target)).toBe(true)
  })

  it('refuses when the marker was staged against a different source', async () => {
    const target = await seedVerifiedMarker(emptyParent, '/some/other/OpenScience')

    const result = await discardStagedCopy(
      { currentDataRoot, expectedToken: 'tok-test' },
      emptyParent
    )

    expect(result).toEqual({ ok: false, error: 'Refused: not a completed, matching staged copy.' })
    expect(existsSync(target)).toBe(true)
  })

  it('refuses a "copying" marker unless the caller confirms its owner process has exited', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot, { status: 'copying' })

    const result = await discardStagedCopy(
      { currentDataRoot, expectedToken: 'tok-test' },
      emptyParent
    )

    expect(result).toEqual({ ok: false, error: 'Refused: not a completed, matching staged copy.' })
    expect(existsSync(target)).toBe(true)
  })

  it('discards an interrupted "copying" marker after its owner process has exited', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot, { status: 'copying' })

    const result = await discardStagedCopy(
      { currentDataRoot, expectedToken: 'tok-test', allowIncomplete: true },
      emptyParent
    )

    expect(result).toEqual({ ok: true })
    expect(existsSync(target)).toBe(false)
  })

  it('refuses when the staged token does not match the session token', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)

    const result = await discardStagedCopy(
      { currentDataRoot, expectedToken: 'other-token' },
      emptyParent
    )

    expect(result).toEqual({ ok: false, error: 'Refused: not a completed, matching staged copy.' })
    expect(existsSync(target)).toBe(true)
  })
})

describe('runtime preservation + old-runtime cleanup', () => {
  it('exports env locks and copies the pkgs cache when envs are preserved', async () => {
    const deps = fakeDeps()
    const exportRuntimeLocks = vi.fn(async (_source: string, target: string) => {
      const locks = join(target, 'runtime', 'envs.lock')
      await mkdir(locks, { recursive: true })
      await writeFile(join(locks, 'default-python.lock'), '@EXPLICIT\nhttps://example.test/pkg')
      return ['default-python']
    })
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))

    const target = dataRootFor(emptyParent)
    await runDataRootMigration(
      {
        currentDataRoot,
        runtime: deps.runtime,
        notebook: deps.notebook,
        exportRuntimeLocks,
        copyAndVerify
      },
      emptyParent,
      runOpts()
    )

    expect(exportRuntimeLocks).toHaveBeenCalledWith(currentDataRoot, target)
    // The (relocatable) pkgs cache is copied alongside the user data so envs rebuild offline there.
    expect(copyAndVerify).toHaveBeenCalledWith(
      expect.objectContaining({
        dirs: [
          ...MIGRATED_DIRS,
          RUNTIME_ENVIRONMENT_MANIFESTS_DIR,
          RUNTIME_REPAIR_REGISTRY_FILE,
          join('runtime', 'pkgs')
        ]
      })
    )
    const marker = await readMigrationMarker(target)
    expect(marker?.runtimeLockInventory).toEqual(
      await scanInventory(target, [join('runtime', 'envs.lock')])
    )
  })

  it('copies durable package archives even when no environment was preserved', async () => {
    const deps = fakeDeps()
    const exportRuntimeLocks = vi.fn(async () => [] as string[])
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))

    await runDataRootMigration(
      {
        currentDataRoot,
        runtime: deps.runtime,
        notebook: deps.notebook,
        exportRuntimeLocks,
        copyAndVerify
      },
      emptyParent,
      runOpts()
    )

    expect(copyAndVerify).toHaveBeenCalledWith(
      expect.objectContaining({
        dirs: [
          ...MIGRATED_DIRS,
          RUNTIME_ENVIRONMENT_MANIFESTS_DIR,
          RUNTIME_REPAIR_REGISTRY_FILE,
          join('runtime', 'pkgs')
        ]
      })
    )
  })

  it('still copies user data but removes an unpublished bundle when lock export throws', async () => {
    const deps = fakeDeps()
    const logger = fakeDiagnosticLogger()
    const exportRuntimeLocks = vi.fn(async (_source: string, target: string) => {
      const locks = join(target, 'runtime', 'envs.lock')
      await mkdir(locks, { recursive: true })
      await writeFile(join(locks, 'partial.lock'), '@EXPLICIT\nhttps://example.test/partial')
      throw new Error('micromamba boom')
    })
    const copyAndVerify = vi.fn(async (): Promise<MigrationResult> => ({ ok: true }))

    const result = await runDataRootMigration(
      {
        currentDataRoot,
        runtime: deps.runtime,
        notebook: deps.notebook,
        exportRuntimeLocks,
        copyAndVerify,
        logger
      },
      emptyParent,
      runOpts()
    )

    expect(result).toEqual({ ok: true })
    expect(copyAndVerify).toHaveBeenCalledWith(
      expect.objectContaining({
        dirs: [
          ...MIGRATED_DIRS,
          RUNTIME_ENVIRONMENT_MANIFESTS_DIR,
          RUNTIME_REPAIR_REGISTRY_FILE,
          join('runtime', 'pkgs')
        ]
      })
    )
    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-copy',
        phase: 'verify-target',
        outcome: 'completed',
        preservedEnvironmentCount: 0,
        runtimePreservationDegraded: true
      })
    )
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain('micromamba boom')
    const target = dataRootFor(emptyParent)
    expect((await readMigrationMarker(target))?.runtimeLockInventory).toBeUndefined()
    expect(existsSync(join(target, 'runtime', 'envs.lock'))).toBe(false)
  })

  it('deletes the old runtime when the verified receipt matches the complete bundle', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
    const deps = fakeDeps()
    const locks = join(target, 'runtime', 'envs.lock')
    await mkdir(locks, { recursive: true })
    await writeFile(join(locks, 'default-python.lock'), '@EXPLICIT\nhttps://example.test/pkg')
    await mkdir(join(target, 'runtime', 'pkgs'), { recursive: true })
    await writeMigrationMarker(target, {
      ...(await readMigrationMarker(target))!,
      runtimeLockInventory: await scanInventory(target, [join('runtime', 'envs.lock')])
    })
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] }))

    await commitDataRootSwitch(
      { currentDataRoot, setDataRoot: deps.setDataRoot, deleteSources, expectedToken: 'tok-test' },
      emptyParent
    )

    expect(deleteSources).toHaveBeenCalledWith(currentDataRoot, [...MIGRATED_DIRS, 'runtime'])
  })

  it('leaves the old runtime intact when a legacy marker has no runtime lock receipt', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
    const deps = fakeDeps()
    const locks = join(target, 'runtime', 'envs.lock')
    await mkdir(locks, { recursive: true })
    await writeFile(join(locks, 'default-python.lock'), '@EXPLICIT\nhttps://example.test/pkg')
    await mkdir(join(target, 'runtime', 'pkgs'), { recursive: true })
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] }))

    await commitDataRootSwitch(
      { currentDataRoot, setDataRoot: deps.setDataRoot, deleteSources, expectedToken: 'tok-test' },
      emptyParent
    )

    expect(deleteSources).toHaveBeenCalledWith(currentDataRoot, [...MIGRATED_DIRS])
  })

  it('leaves the old runtime intact when the runtime lock receipt was tampered with', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
    const deps = fakeDeps()
    const locks = join(target, 'runtime', 'envs.lock')
    await mkdir(locks, { recursive: true })
    await writeFile(join(locks, 'default-python.lock'), '@EXPLICIT\nhttps://example.test/pkg')
    await mkdir(join(target, 'runtime', 'pkgs'), { recursive: true })
    const receipt = await scanInventory(target, [join('runtime', 'envs.lock')])
    await writeMigrationMarker(target, {
      ...(await readMigrationMarker(target))!,
      runtimeLockInventory: { ...receipt, digest: '0'.repeat(64) }
    })
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] }))

    await commitDataRootSwitch(
      { currentDataRoot, setDataRoot: deps.setDataRoot, deleteSources, expectedToken: 'tok-test' },
      emptyParent
    )

    expect(deleteSources).toHaveBeenCalledWith(currentDataRoot, [...MIGRATED_DIRS])
  })

  it('leaves the old runtime intact when a runtime lock changes after verification', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
    const deps = fakeDeps()
    const locks = join(target, 'runtime', 'envs.lock')
    const lock = join(locks, 'default-python.lock')
    await mkdir(locks, { recursive: true })
    await writeFile(lock, '@EXPLICIT\nhttps://example.test/original')
    await mkdir(join(target, 'runtime', 'pkgs'), { recursive: true })
    await writeMigrationMarker(target, {
      ...(await readMigrationMarker(target))!,
      runtimeLockInventory: await scanInventory(target, [join('runtime', 'envs.lock')])
    })
    await writeFile(lock, '@EXPLICIT\nhttps://example.test/tampered')
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] }))

    await commitDataRootSwitch(
      { currentDataRoot, setDataRoot: deps.setDataRoot, deleteSources, expectedToken: 'tok-test' },
      emptyParent
    )

    expect(deleteSources).toHaveBeenCalledWith(currentDataRoot, [...MIGRATED_DIRS])
  })

  it('leaves the old runtime intact when the verified locks have no package cache', async () => {
    const target = await seedVerifiedMarker(emptyParent, currentDataRoot)
    const deps = fakeDeps()
    const locks = join(target, 'runtime', 'envs.lock')
    await mkdir(locks, { recursive: true })
    await writeFile(join(locks, 'default-python.lock'), '@EXPLICIT\nhttps://example.test/pkg')
    await writeMigrationMarker(target, {
      ...(await readMigrationMarker(target))!,
      runtimeLockInventory: await scanInventory(target, [join('runtime', 'envs.lock')])
    })
    const deleteSources = vi.fn(async (): Promise<DeleteResult> => ({ deleted: [], failed: [] }))

    await commitDataRootSwitch(
      { currentDataRoot, setDataRoot: deps.setDataRoot, deleteSources, expectedToken: 'tok-test' },
      emptyParent
    )

    expect(deleteSources).toHaveBeenCalledWith(currentDataRoot, [...MIGRATED_DIRS])
  })
})
