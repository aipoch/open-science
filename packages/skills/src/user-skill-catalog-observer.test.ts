import type { FSWatcher, watch } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { UserSkillCatalogObserver } from './user-skill-catalog-observer'
import { UserSkillRepository } from './user-skill-repository'

const makeStorage = (): Promise<string> => mkdtemp(join(tmpdir(), 'skill-catalog-observer-'))

const fakeWatcher = (): {
  watchDirectory: typeof watch
  emitChange: () => void
  close: ReturnType<typeof vi.fn>
} => {
  const emitter = new EventEmitter()
  const close = vi.fn()
  const watcher = Object.assign(emitter, {
    close,
    ref: vi.fn(),
    unref: vi.fn()
  }) as unknown as FSWatcher
  let listener: (() => void) | undefined
  const watchDirectory = vi.fn((_path, _options, onChange) => {
    listener = onChange as () => void
    return watcher
  }) as unknown as typeof watch

  return { watchDirectory, emitChange: () => listener?.(), close }
}

const waitForCalls = async (callback: ReturnType<typeof vi.fn>, count: number): Promise<void> => {
  await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(count))
}

describe('UserSkillCatalogObserver', () => {
  it('starts watching without waiting for the initial catalog scan', async () => {
    const watcher = fakeWatcher()
    let finishInitialScan: ((skills: []) => void) | undefined
    const list = vi.fn<() => Promise<[]>>(
      () => new Promise<[]>((resolve) => (finishInitialScan = resolve))
    )
    const onCatalogChanged = vi.fn()
    const observer = new UserSkillCatalogObserver({
      storageRoot: await makeStorage(),
      catalog: { list },
      onCatalogChanged,
      watchDirectory: watcher.watchDirectory,
      reconcileIntervalMs: 60_000
    })

    await observer.start()

    expect(watcher.watchDirectory).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledOnce()
    observer.dispose()
    finishInitialScan?.([])
    await Promise.resolve()
    expect(onCatalogChanged).not.toHaveBeenCalled()
  })

  it('reconciles a filesystem event that arrives during the initial scan', async () => {
    const watcher = fakeWatcher()
    let finishInitialScan: ((skills: []) => void) | undefined
    const changedSkill = {
      id: 'personal-direct',
      name: 'direct',
      displayName: 'Direct',
      description: 'Directly installed.',
      source: 'personal' as const,
      updatedAt: '2026-08-25T00:00:00.000Z',
      sourceDir: '/skills/personal/direct'
    }
    const list = vi
      .fn()
      .mockImplementationOnce(() => new Promise<[]>((resolve) => (finishInitialScan = resolve)))
      .mockResolvedValue([changedSkill])
    const onCatalogChanged = vi.fn()
    const observer = new UserSkillCatalogObserver({
      storageRoot: await makeStorage(),
      catalog: { list },
      onCatalogChanged,
      watchDirectory: watcher.watchDirectory,
      debounceMs: 1,
      reconcileIntervalMs: 60_000
    })
    await observer.start()

    watcher.emitChange()
    await new Promise((resolve) => setTimeout(resolve, 5))
    finishInitialScan?.([])

    await waitForCalls(list, 2)
    await waitForCalls(onCatalogChanged, 2)
    observer.dispose()
  })

  it('publishes the first successful retry after the initial scan fails', async () => {
    const watcher = fakeWatcher()
    const list = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue([])
    const onCatalogChanged = vi.fn()
    const observer = new UserSkillCatalogObserver({
      storageRoot: await makeStorage(),
      catalog: { list },
      onCatalogChanged,
      watchDirectory: watcher.watchDirectory,
      debounceMs: 1,
      reconcileIntervalMs: 60_000
    })
    await observer.start()
    await new Promise((resolve) => setTimeout(resolve, 0))

    watcher.emitChange()

    await waitForCalls(list, 2)
    await waitForCalls(onCatalogChanged, 1)
    observer.dispose()
  })

  it('retries an unchanged catalog after publishing fails without another filesystem event', async () => {
    vi.useFakeTimers()
    const watcher = fakeWatcher()
    const list = vi.fn<() => Promise<[]>>().mockResolvedValue([])
    const onCatalogChanged = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('reload failed'))
      .mockResolvedValue(undefined)
    const observer = new UserSkillCatalogObserver({
      storageRoot: await makeStorage(),
      catalog: { list },
      onCatalogChanged,
      watchDirectory: watcher.watchDirectory,
      debounceMs: 1,
      reconcileIntervalMs: 100
    })
    try {
      await observer.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(onCatalogChanged).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(100)

      expect(list).toHaveBeenCalledTimes(2)
      expect(onCatalogChanged).toHaveBeenCalledTimes(2)
    } finally {
      observer.dispose()
      vi.useRealTimers()
    }
  })

  it('retries a failed forced publication when the catalog is unchanged', async () => {
    vi.useFakeTimers()
    const watcher = fakeWatcher()
    const list = vi.fn<() => Promise<[]>>().mockResolvedValue([])
    const onCatalogChanged = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('reload failed'))
      .mockResolvedValue(undefined)
    const observer = new UserSkillCatalogObserver({
      storageRoot: await makeStorage(),
      catalog: { list },
      onCatalogChanged,
      watchDirectory: watcher.watchDirectory,
      reconcileIntervalMs: 100
    })
    try {
      await observer.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(onCatalogChanged).toHaveBeenCalledOnce()

      await expect(observer.notifyCatalogChanged()).rejects.toThrow('reload failed')
      await vi.advanceTimersByTimeAsync(100)

      expect(list).toHaveBeenCalledTimes(3)
      expect(onCatalogChanged).toHaveBeenCalledTimes(3)
    } finally {
      observer.dispose()
      vi.useRealTimers()
    }
  })

  it('publishes valid direct additions and ignores malformed packages', async () => {
    const storageRoot = await makeStorage()
    const watcher = fakeWatcher()
    const onCatalogChanged = vi.fn()
    const catalog = new UserSkillRepository(storageRoot)
    const list = vi.spyOn(catalog, 'list')
    const observer = new UserSkillCatalogObserver({
      storageRoot,
      catalog,
      onCatalogChanged,
      watchDirectory: watcher.watchDirectory,
      debounceMs: 1,
      reconcileIntervalMs: 60_000
    })
    await observer.start()
    await waitForCalls(list, 1)
    await list.mock.results[0].value
    await waitForCalls(onCatalogChanged, 1)

    const direct = join(storageRoot, 'skills', 'personal', 'direct')
    await mkdir(direct, { recursive: true })
    watcher.emitChange()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onCatalogChanged).toHaveBeenCalledOnce()

    await writeFile(
      join(direct, 'SKILL.md'),
      '---\nname: direct\ndescription: Directly installed.\n---\nUse this Skill.\n'
    )
    watcher.emitChange()
    await waitForCalls(onCatalogChanged, 2)

    observer.dispose()
    expect(watcher.close).toHaveBeenCalledOnce()
  })

  it('publishes supporting-file changes and deduplicates unchanged watcher events', async () => {
    const storageRoot = await makeStorage()
    const skillDirectory = join(storageRoot, 'skills', 'imported', 'bundle')
    await mkdir(join(skillDirectory, 'scripts'), { recursive: true })
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      '---\nname: bundle\ndescription: Bundled.\n---\nRun the script.\n'
    )
    await writeFile(join(skillDirectory, 'scripts', 'run.js'), 'console.log("v1")\n')

    const watcher = fakeWatcher()
    const onCatalogChanged = vi.fn()
    const catalog = new UserSkillRepository(storageRoot)
    const list = vi.spyOn(catalog, 'list')
    const observer = new UserSkillCatalogObserver({
      storageRoot,
      catalog,
      onCatalogChanged,
      watchDirectory: watcher.watchDirectory,
      debounceMs: 1,
      reconcileIntervalMs: 60_000
    })
    await observer.start()
    await waitForCalls(list, 1)
    await list.mock.results[0].value
    await waitForCalls(onCatalogChanged, 1)

    watcher.emitChange()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onCatalogChanged).toHaveBeenCalledOnce()

    await writeFile(join(skillDirectory, 'scripts', 'run.js'), 'console.log("v2")\n')
    watcher.emitChange()
    await waitForCalls(onCatalogChanged, 2)

    observer.dispose()
  })

  it('publishes helper descriptor changes even without a package compatibility fingerprint', async () => {
    const watcher = fakeWatcher()
    const base = {
      id: 'personal-plot',
      name: 'plot',
      displayName: 'Plot',
      description: 'Plot helper.',
      source: 'personal' as const,
      updatedAt: '2026-08-25T00:00:00.000Z',
      sourceDir: '/skills/personal/plot'
    }
    const descriptor = {
      id: 'plot-helper',
      language: 'python' as const,
      interfaceRevision: 1,
      implementation: 'kernel.py',
      exports: ['plot'],
      dependencies: []
    }
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ ...base, helpers: [descriptor] }])
      .mockResolvedValue([{ ...base, helpers: [{ ...descriptor, exports: ['plot_v2'] }] }])
    const onCatalogChanged = vi.fn()
    const observer = new UserSkillCatalogObserver({
      storageRoot: await makeStorage(),
      catalog: { list },
      onCatalogChanged,
      watchDirectory: watcher.watchDirectory,
      debounceMs: 1,
      reconcileIntervalMs: 60_000
    })
    await observer.start()
    await waitForCalls(list, 1)
    await list.mock.results[0].value
    await waitForCalls(onCatalogChanged, 1)

    watcher.emitChange()

    await waitForCalls(onCatalogChanged, 2)
    observer.dispose()
  })

  it('forces one shared notification for explicit catalog mutations', async () => {
    const watcher = fakeWatcher()
    const onCatalogChanged = vi.fn()
    const storageRoot = await makeStorage()
    const observer = new UserSkillCatalogObserver({
      storageRoot,
      catalog: new UserSkillRepository(storageRoot),
      onCatalogChanged,
      watchDirectory: watcher.watchDirectory,
      reconcileIntervalMs: 60_000
    })
    await observer.start()

    await observer.notifyCatalogChanged()

    expect(onCatalogChanged).toHaveBeenCalledTimes(2)
    observer.dispose()
  })

  it('coalesces a burst to one running and one pending reconciliation', async () => {
    const watcher = fakeWatcher()
    let finishRunningScan: ((skills: []) => void) | undefined
    const list = vi
      .fn<() => Promise<[]>>()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => new Promise<[]>((resolve) => (finishRunningScan = resolve)))
      .mockResolvedValue([])
    const observer = new UserSkillCatalogObserver({
      storageRoot: await makeStorage(),
      catalog: { list },
      onCatalogChanged: vi.fn(),
      watchDirectory: watcher.watchDirectory,
      reconcileIntervalMs: 60_000
    })
    await observer.start()

    const first = observer.notifyCatalogChanged()
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    const second = observer.notifyCatalogChanged()
    const third = observer.notifyCatalogChanged()
    expect(list).toHaveBeenCalledTimes(2)

    finishRunningScan?.([])
    await Promise.all([first, second, third])

    expect(list).toHaveBeenCalledTimes(3)
    observer.dispose()
  })

  it('upgrades a pending watcher reconciliation when a forced notification joins it', async () => {
    const watcher = fakeWatcher()
    let finishRunningScan: ((skills: []) => void) | undefined
    const list = vi
      .fn<() => Promise<[]>>()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => new Promise<[]>((resolve) => (finishRunningScan = resolve)))
      .mockResolvedValue([])
    const onCatalogChanged = vi.fn()
    const observer = new UserSkillCatalogObserver({
      storageRoot: await makeStorage(),
      catalog: { list },
      onCatalogChanged,
      watchDirectory: watcher.watchDirectory,
      debounceMs: 1,
      reconcileIntervalMs: 60_000
    })
    await observer.start()

    watcher.emitChange()
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    const forced = observer.notifyCatalogChanged()
    finishRunningScan?.([])
    await forced

    expect(list).toHaveBeenCalledTimes(3)
    expect(onCatalogChanged).toHaveBeenCalledTimes(2)
    observer.dispose()
  })

  it('reconciles every thirty seconds when recursive watching is unavailable', async () => {
    vi.useFakeTimers()
    const list = vi.fn<() => Promise<[]>>().mockResolvedValue([])
    const watchDirectory = vi.fn(() => {
      throw new Error('recursive watch unavailable')
    }) as unknown as typeof watch
    const observer = new UserSkillCatalogObserver({
      storageRoot: await makeStorage(),
      catalog: { list },
      onCatalogChanged: vi.fn(),
      watchDirectory,
      debounceMs: 1
    })

    try {
      await observer.start()
      await vi.advanceTimersByTimeAsync(29_999)
      expect(list).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(2)
      expect(list).toHaveBeenCalledTimes(2)
    } finally {
      observer.dispose()
      vi.useRealTimers()
    }
  })

  it('does not poll when recursive watching starts successfully', async () => {
    vi.useFakeTimers()
    const watcher = fakeWatcher()
    const list = vi.fn<() => Promise<[]>>().mockResolvedValue([])
    const observer = new UserSkillCatalogObserver({
      storageRoot: await makeStorage(),
      catalog: { list },
      onCatalogChanged: vi.fn(),
      watchDirectory: watcher.watchDirectory
    })

    try {
      await observer.start()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(list).toHaveBeenCalledOnce()
    } finally {
      observer.dispose()
      vi.useRealTimers()
    }
  })

  it('accepts a new notification immediately after an awaited drain', async () => {
    const watcher = fakeWatcher()
    const list = vi.fn<() => Promise<[]>>().mockResolvedValue([])
    const onCatalogChanged = vi.fn()
    const observer = new UserSkillCatalogObserver({
      storageRoot: await makeStorage(),
      catalog: { list },
      onCatalogChanged,
      watchDirectory: watcher.watchDirectory,
      reconcileIntervalMs: 60_000
    })
    await observer.start()

    await observer.notifyCatalogChanged()
    await observer.notifyCatalogChanged()

    expect(list).toHaveBeenCalledTimes(3)
    expect(onCatalogChanged).toHaveBeenCalledTimes(3)
    observer.dispose()
  })
})
