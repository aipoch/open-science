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
  it('publishes valid direct additions and ignores malformed packages', async () => {
    const storageRoot = await makeStorage()
    const watcher = fakeWatcher()
    const onCatalogChanged = vi.fn()
    const observer = new UserSkillCatalogObserver({
      storageRoot,
      catalog: new UserSkillRepository(storageRoot),
      onCatalogChanged,
      watchDirectory: watcher.watchDirectory,
      debounceMs: 1,
      reconcileIntervalMs: 60_000
    })
    await observer.start()

    const direct = join(storageRoot, 'skills', 'personal', 'direct')
    await mkdir(direct, { recursive: true })
    watcher.emitChange()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onCatalogChanged).not.toHaveBeenCalled()

    await writeFile(
      join(direct, 'SKILL.md'),
      '---\nname: direct\ndescription: Directly installed.\n---\nUse this Skill.\n'
    )
    watcher.emitChange()
    await waitForCalls(onCatalogChanged, 1)

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
    const observer = new UserSkillCatalogObserver({
      storageRoot,
      catalog: new UserSkillRepository(storageRoot),
      onCatalogChanged,
      watchDirectory: watcher.watchDirectory,
      debounceMs: 1,
      reconcileIntervalMs: 60_000
    })
    await observer.start()

    watcher.emitChange()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onCatalogChanged).not.toHaveBeenCalled()

    await writeFile(join(skillDirectory, 'scripts', 'run.js'), 'console.log("v2")\n')
    watcher.emitChange()
    await waitForCalls(onCatalogChanged, 1)

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

    expect(onCatalogChanged).toHaveBeenCalledOnce()
    observer.dispose()
  })
})
