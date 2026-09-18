import { mkdir, mkdtemp, rename, rm, writeFile, readFile, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({
  afterRealpath: undefined as ((path: string) => Promise<void>) | undefined,
  beforeMkdir: undefined as ((path: string) => Promise<void>) | undefined,
  afterMkdir: undefined as ((path: string) => Promise<void>) | undefined
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    realpath: async (...args: Parameters<typeof fs.realpath>) => {
      const result = await fs.realpath(...args)
      await fault.afterRealpath?.(String(args[0]))
      return result
    },
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      await fault.beforeMkdir?.(String(args[0]))
      const result = await fs.mkdir(...args)
      await fault.afterMkdir?.(String(args[0]))
      return result
    }
  }
})
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/virtual/home' } }))
vi.mock('./remote-data-root', () => ({
  inspectWindowsStoragePath: () => ({ isRemote: false, supportsHardLinks: true })
}))
import { runDataRootMigration } from './migration-service'
import { createStorageCommandOwner } from './command-owner'
import { initDataRoot } from '../storage-root'
import { clearMigrationPending } from './migration-state'

it.each([true, false])(
  'preserves a replacement directory when writer pause fails=%s',
  async (fails) => {
    const fixture = await mkdtemp(join(tmpdir(), 'staging-replacement-'))
    const source = join(fixture, 'source')
    const picked = join(fixture, 'picked')
    const target = join(picked, 'Open-Science')
    try {
      await mkdir(source)
      await mkdir(picked)
      const copy = vi.fn().mockResolvedValue({ ok: true })
      const result = await runDataRootMigration(
        {
          currentDataRoot: source,
          runtime: {
            disconnect: async () => {
              await rename(target, join(picked, 'original-staged'))
              await mkdir(target)
              await writeFile(join(target, 'unrelated.txt'), 'preserve')
              if (fails) throw new Error('pause failed')
            }
          },
          notebook: { shutdownAll: async () => ({ reaped: true }) },
          copyAndVerify: copy,
          validateProvenanceState: async () => {}
        },
        picked,
        { signal: new AbortController().signal, onProgress: () => {} }
      )
      expect(await readFile(join(target, 'unrelated.txt'), 'utf8')).toBe('preserve')
      expect(result.ok).toBe(false)
      expect(copy).not.toHaveBeenCalled()
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }
)

it.each(['copy', 'direct'])(
  'does not claim a replaced new directory after asynchronous creation (%s)',
  async (mode) => {
    const fixture = await mkdtemp(join(tmpdir(), 'new-target-race-'))
    const source = join(fixture, 'source')
    const picked = join(fixture, 'picked')
    const target = join(picked, 'Open-Science')
    let replaced = false
    try {
      await mkdir(source)
      await mkdir(picked)
      fault.afterMkdir = async (path) => {
        if (path !== target) return
        fault.afterMkdir = undefined
        await rename(target, join(picked, 'created-original'))
        await mkdir(target)
        replaced = true
      }
      const persist = vi.fn()
      let result
      if (mode === 'copy') {
        result = await runDataRootMigration(
          {
            currentDataRoot: source,
            runtime: { disconnect: async () => {} },
            notebook: { shutdownAll: async () => ({ reaped: true }) },
            copyAndVerify: async () => ({ ok: true }),
            validateProvenanceState: async () => {}
          },
          picked,
          { signal: new AbortController().signal, onProgress: () => {} }
        )
      } else {
        initDataRoot(source)
        const owner = createStorageCommandOwner({
          runtime: { disconnect: async () => {}, shutdownForQuit: async () => ({ reaped: true }) },
          notebook: {
            shutdownAll: async () => ({ reaped: true }),
            dispose: async () => ({ reaped: true }),
            getActiveNotebookSessions: () => []
          },
          getActivePromptSessions: () => [],
          getActiveSideChatSessions: () => [],
          getActiveDelegatedSessions: () => [],
          hasActiveReviewerWork: () => false,
          settingsService: {
            setDataRoot: persist,
            getStoredSettings: async () => ({}),
            dismissLegacyDataMovePrompt: async () => {}
          },
          relaunch: () => {}
        })
        result = await owner.setDataRootAndRelaunch({ parent: picked })
      }
      expect(result.ok).toBe(!replaced)
      if (replaced) expect(persist).not.toHaveBeenCalled()
      else expect(existsSync(target)).toBe(true)
    } finally {
      fault.afterMkdir = undefined
      clearMigrationPending()
      await rm(fixture, { recursive: true, force: true })
    }
  }
)

it('does not reclaim an existing empty target replaced at the mkdir boundary', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'migration-target-race-'))
  const source = join(fixture, 'source')
  const picked = join(fixture, 'picked')
  const target = join(picked, 'Open-Science')
  try {
    await mkdir(source)
    await mkdir(target, { recursive: true })
    const copy = vi.fn().mockResolvedValue({ ok: true })
    fault.beforeMkdir = async (path) => {
      if (path !== target) return
      fault.beforeMkdir = undefined
      await rename(target, join(picked, 'original-target'))
    }
    const result = await runDataRootMigration(
      {
        currentDataRoot: source,
        runtime: { disconnect: async () => {} },
        notebook: { shutdownAll: async () => ({ reaped: true }) },
        copyAndVerify: copy,
        validateProvenanceState: async () => {}
      },
      picked,
      { signal: new AbortController().signal, onProgress: () => {} }
    )
    // If preparation no longer mkdirs an already-existing target, the fault is not reached and
    // its original directory is preserved. If reached, replacement must be refused before copy.
    if (!fault.beforeMkdir) {
      expect(result.ok).toBe(false)
      expect(copy).not.toHaveBeenCalled()
    } else {
      expect(existsSync(join(picked, 'original-target'))).toBe(false)
      expect(result.ok).toBe(true)
    }
  } finally {
    fault.beforeMkdir = undefined
    await rm(fixture, { recursive: true, force: true })
  }
})

// Faults occur in the real canonical-path check after its answer was computed, before preparation
// resumes. Neither a matching pathname nor a conventional inventory dirname confers deletion rights.
it.each(['replace-target', 'link-provenance', 'unowned-inventory'])(
  'preserves unowned inventory before staging cleanup (%s)',
  async (faultKind) => {
    const fixture = await mkdtemp(join(tmpdir(), 'migration-cleanup-race-'))
    const source = join(fixture, 'source')
    const picked = join(fixture, 'picked')
    const target = join(picked, 'Open-Science')
    const foreign = join(fixture, 'foreign')
    const inventory = join('runtime', 'provenance', 'environment-inventory')
    let checks = 0
    let injected = false
    try {
      await mkdir(source)
      await mkdir(join(target, 'runtime'), { recursive: true })
      await mkdir(join(foreign, 'environment-inventory'), { recursive: true })
      const seedInventory = async (): Promise<void> => {
        await mkdir(join(target, inventory), { recursive: true })
        await writeFile(join(target, inventory, 'preserve.json'), 'unrelated inventory')
      }
      if (faultKind === 'unowned-inventory') await seedInventory()
      else
        fault.afterRealpath = async (path) => {
          if (path !== target || ++checks !== 2) return
          fault.afterRealpath = undefined
          injected = true
          if (faultKind === 'replace-target') {
            await rename(target, join(picked, 'original'))
            await seedInventory()
          } else {
            await writeFile(
              join(foreign, 'environment-inventory', 'preserve.json'),
              'unrelated inventory'
            )
            await symlink(
              foreign,
              join(target, 'runtime', 'provenance'),
              process.platform === 'win32' ? 'junction' : 'dir'
            )
          }
        }
      const copy = vi.fn().mockResolvedValue({ ok: true })
      const result = await runDataRootMigration(
        {
          currentDataRoot: source,
          runtime: { disconnect: async () => {} },
          notebook: { shutdownAll: async () => ({ reaped: true }) },
          copyAndVerify: copy,
          validateProvenanceState: async () => {}
        },
        picked,
        { signal: new AbortController().signal, onProgress: () => {} }
      )
      if (faultKind !== 'unowned-inventory') expect(injected).toBe(true)
      expect(await readFile(join(target, inventory, 'preserve.json'), 'utf8')).toBe(
        'unrelated inventory'
      )
      expect(result.ok).toBe(false)
      expect(copy).not.toHaveBeenCalled()
    } finally {
      fault.afterRealpath = undefined
      await rm(fixture, { recursive: true, force: true })
    }
  }
)
