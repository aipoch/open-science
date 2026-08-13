import { watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { SkillSource } from '../../shared/settings'
import { createLogger, diagnosticErrorFields } from '../logger'
import type { BundledSkill } from './registry'

const log = createLogger('skills')
const DEFAULT_DEBOUNCE_MS = 150
const DEFAULT_RECONCILE_INTERVAL_MS = 2_000
const OBSERVED_SOURCES: readonly Extract<SkillSource, 'imported' | 'personal'>[] = [
  'imported',
  'personal'
]

type UserSkillCatalog = {
  list(): Promise<readonly BundledSkill[]>
}

type UserSkillCatalogObserverOptions = {
  storageRoot: string
  onCatalogChanged: () => void | Promise<void>
  catalog: UserSkillCatalog
  watchDirectory?: typeof watch
  debounceMs?: number
  reconcileIntervalMs?: number
}

const catalogFingerprint = (skills: readonly BundledSkill[]): string =>
  JSON.stringify(
    skills
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        displayName: skill.displayName,
        description: skill.description,
        source: skill.source,
        updatedAt: skill.updatedAt,
        compatibility: skill.compatibility,
        author: skill.author,
        license: skill.license,
        thirdParty: skill.thirdParty
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  )

// Observes only the application-managed writable catalog. The repository remains the authority for
// recovery and validation, so hidden transaction directories and malformed packages never produce a
// catalog event. If recursive fs.watch is unavailable or later fails, a bounded periodic
// reconciliation keeps direct filesystem installs discoverable across supported platforms.
class UserSkillCatalogObserver {
  private watcher: FSWatcher | undefined
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private reconcileTimer: ReturnType<typeof setInterval> | undefined
  private fingerprint = ''
  private reconcileTail = Promise.resolve()
  private disposed = false

  constructor(private readonly options: UserSkillCatalogObserverOptions) {}

  async start(): Promise<void> {
    const skillsRoot = join(this.options.storageRoot, 'skills')
    await Promise.all(
      OBSERVED_SOURCES.map((source) => mkdir(join(skillsRoot, source), { recursive: true }))
    )
    this.fingerprint = catalogFingerprint(await this.options.catalog.list())

    try {
      this.watcher = (this.options.watchDirectory ?? watch)(skillsRoot, { recursive: true }, () =>
        this.scheduleReconcile()
      )
      this.watcher.on('error', (error) => {
        log.warn('user skill catalog watcher failed; periodic reconciliation remains active', {
          ...diagnosticErrorFields(error)
        })
        this.watcher?.close()
        this.watcher = undefined
        this.startPeriodicReconciliation()
      })
    } catch (error) {
      log.warn('user skill catalog watcher unavailable; using periodic reconciliation', {
        ...diagnosticErrorFields(error)
      })
      this.startPeriodicReconciliation()
    }
  }

  notifyCatalogChanged(): Promise<void> {
    return this.enqueueReconcile(true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.watcher?.close()
    this.watcher = undefined
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    this.debounceTimer = undefined
    this.reconcileTimer = undefined
  }

  private scheduleReconcile(): void {
    if (this.disposed) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.enqueueReconcile(false)
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    this.debounceTimer.unref?.()
  }

  private startPeriodicReconciliation(): void {
    if (this.disposed || this.reconcileTimer) return
    this.reconcileTimer = setInterval(
      () => this.scheduleReconcile(),
      this.options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
    )
    this.reconcileTimer.unref?.()
  }

  private enqueueReconcile(force: boolean): Promise<void> {
    const reconcile = this.reconcileTail.then(() => this.reconcile(force))
    this.reconcileTail = reconcile.catch((error) => {
      log.warn('user skill catalog reconciliation failed', diagnosticErrorFields(error))
    })
    return reconcile
  }

  private async reconcile(force: boolean): Promise<void> {
    if (this.disposed) return
    const fingerprint = catalogFingerprint(await this.options.catalog.list())
    if (this.disposed) return
    const changed = fingerprint !== this.fingerprint
    this.fingerprint = fingerprint
    if (changed || force) await this.options.onCatalogChanged()
  }
}

export { UserSkillCatalogObserver, catalogFingerprint }
export type { UserSkillCatalogObserverOptions }
