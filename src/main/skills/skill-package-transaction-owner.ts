import { randomUUID } from 'node:crypto'
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { AgentHomeSkillRef, AgentHomeSkillSource, SkillSource } from '../../shared/settings'
import { createLogger } from '../logger'
import { type SkillMutationOwner, skillMutationOwnerFor } from './skill-mutation-owner'

export type { SkillMutationOwner } from './skill-mutation-owner'

const log = createLogger('skills')

type WritableSkillSource = Extract<SkillSource, 'imported' | 'personal'>

const WRITABLE_SOURCES: readonly WritableSkillSource[] = ['imported', 'personal']
const TRANSACTION_DIR = /^\.([a-z0-9-]+)\.(import|backup)-(.+)$/
const SAFE_AGENT_HOME_SKILL_SLUG = /^[a-z0-9-]+$/

const nextGeneration = (): string => `${Date.now().toString().padStart(15, '0')}-${randomUUID()}`

const isAgentHomeSkillSource = (value: unknown): value is AgentHomeSkillSource =>
  value === 'agents' || value === 'claude' || value === 'codex'

export const SOURCE_MANIFEST = '.source.json'

export type ImportedSourceManifest = {
  url?: string
  signature?: string
  agentHome?: AgentHomeSkillRef
}

export type StagedSkillPackage = Readonly<{
  source: WritableSkillSource
  directoryName: string
  staging: string
  generation: string
}>

type ExternalRecoveryBarrier = <T>(operation: () => Promise<T>) => Promise<T>

// Owns the one writable-Skill transaction protocol: shared locking, crash recovery, sibling staging,
// atomic promotion/rollback, cleanup, and the private source manifest. Callers decide what package
// bytes mean; this owner decides when they become live and how an interrupted replace is recovered.
export class SkillPackageTransactionOwner {
  private readonly mutationOwner: SkillMutationOwner
  private validatePromoted?: (staged: StagedSkillPackage) => Promise<void>

  constructor(
    private readonly storageRoot: string,
    mutationOwner: SkillMutationOwner = skillMutationOwnerFor(storageRoot),
    private readonly withExternalRecoveryBarrier?: ExternalRecoveryBarrier
  ) {
    this.mutationOwner = mutationOwner
  }

  setPromotedValidator(validate: (staged: StagedSkillPackage) => Promise<void>): void {
    this.validatePromoted = validate
  }

  isHeldByCurrentContext(): boolean {
    return this.mutationOwner.isHeldByCurrentContext()
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutationOwner.runExclusive(operation)
  }

  runRecovered<T>(
    operation: () => Promise<T>,
    sources: readonly WritableSkillSource[] = WRITABLE_SOURCES
  ): Promise<T> {
    return this.runAfterRecovery(operation, sources)
  }

  runMutationRecovered<T>(
    operation: () => Promise<T>,
    sources: readonly WritableSkillSource[] = WRITABLE_SOURCES
  ): Promise<T> {
    const run = (): Promise<T> => this.runAfterRecovery(operation, sources)
    return this.withExternalRecoveryBarrier ? this.withExternalRecoveryBarrier(run) : run()
  }

  private runAfterRecovery<T>(
    operation: () => Promise<T>,
    sources: readonly WritableSkillSource[]
  ): Promise<T> {
    return this.runExclusive(async () => {
      for (const source of sources) await this.recover(source)
      return operation()
    })
  }

  async stage(
    source: WritableSkillSource,
    directoryName: string,
    build: (staging: string) => Promise<void>
  ): Promise<StagedSkillPackage> {
    const live = this.skillDirectory(source, directoryName)
    const generation = nextGeneration()
    const staging = join(dirname(live), `.${basename(live)}.import-${generation}`)
    try {
      await build(staging)
      return { source, directoryName, staging, generation }
    } catch (error) {
      await this.discard({ source, directoryName, staging, generation })
      throw error
    }
  }

  async promote(staged: StagedSkillPackage): Promise<void> {
    const live = this.skillDirectory(staged.source, staged.directoryName)
    const backup = join(dirname(live), `.${basename(live)}.backup-${staged.generation}`)
    try {
      const hadExisting = await stat(live).then(
        () => true,
        () => false
      )
      if (hadExisting) await rename(live, backup)

      try {
        await rename(staged.staging, live)
      } catch (swapError) {
        if (hadExisting) {
          try {
            await rename(backup, live)
          } catch (rollbackError) {
            throw new Error(
              `Skill replace failed to swap and could not roll back; the previous copy is preserved at ${basename(backup)} and will be restored on the next operation. swap error: ${String(swapError)}; rollback error: ${String(rollbackError)}`
            )
          }
        }
        throw swapError
      }

      try {
        await this.validatePromoted?.(staged)
      } catch (validationError) {
        await rm(live, { recursive: true, force: true })
        if (hadExisting) await rename(backup, live)
        throw validationError
      }

      if (hadExisting) await rm(backup, { recursive: true, force: true }).catch(() => {})
    } catch (error) {
      await this.discard(staged)
      throw error
    }
  }

  async discard(staged: StagedSkillPackage): Promise<void> {
    await rm(staged.staging, { recursive: true, force: true }).catch(() => undefined)
  }

  async readImportedSource(directoryName: string): Promise<ImportedSourceManifest | null> {
    try {
      const raw = await readFile(
        join(this.skillDirectory('imported', directoryName), SOURCE_MANIFEST),
        'utf8'
      )
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null) return null

      const record = parsed as Record<string, unknown>
      const manifest: ImportedSourceManifest = {}
      if (typeof record.url === 'string') manifest.url = record.url
      if (typeof record.signature === 'string') manifest.signature = record.signature

      if (typeof record.agentHome === 'object' && record.agentHome !== null) {
        const agentHome = record.agentHome as Record<string, unknown>
        if (
          isAgentHomeSkillSource(agentHome.source) &&
          typeof agentHome.slug === 'string' &&
          SAFE_AGENT_HOME_SKILL_SLUG.test(agentHome.slug)
        ) {
          manifest.agentHome = { source: agentHome.source, slug: agentHome.slug }
        }
      }
      return manifest
    } catch {
      return null
    }
  }

  writeSourceManifest(staging: string, manifest: ImportedSourceManifest): Promise<void> {
    return writeFile(join(staging, SOURCE_MANIFEST), JSON.stringify(manifest, null, 2), {
      flag: 'wx'
    })
  }

  private sourceDir(source: WritableSkillSource): string {
    return join(this.storageRoot, 'skills', source)
  }

  private skillDirectory(source: WritableSkillSource, directoryName: string): string {
    return join(this.sourceDir(source), directoryName)
  }

  private async recover(source: WritableSkillSource): Promise<void> {
    const dir = this.sourceDir(source)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }

    const backupsByDirectoryName = new Map<string, { entry: string; generation: string }[]>()
    const stagings: string[] = []
    for (const entry of entries) {
      const match = TRANSACTION_DIR.exec(entry)
      if (!match) continue
      if (match[2] === 'backup') {
        const backups = backupsByDirectoryName.get(match[1]) ?? []
        backups.push({ entry, generation: match[3] })
        backupsByDirectoryName.set(match[1], backups)
      } else {
        stagings.push(entry)
      }
    }

    for (const [directoryName, backups] of backupsByDirectoryName) {
      const live = join(dir, directoryName)
      let liveExists = await stat(live).then(
        () => true,
        () => false
      )
      backups.sort((left, right) => right.generation.localeCompare(left.generation))
      if (liveExists) {
        // A live directory with a backup may have crashed before final validation. Revalidate
        // before deleting any recovery copy, including when only cleanup failed last time.
        const generation = backups[0].generation
        try {
          await this.validatePromoted?.({
            source,
            directoryName,
            staging: join(dir, `.${directoryName}.import-${generation}`),
            generation
          })
        } catch (error) {
          log.warn('interrupted Skill package update failed validation; restoring backup', {
            directoryName,
            error
          })
          await rm(live, { recursive: true, force: true })
          liveExists = false
        }
      }
      for (let index = 0; index < backups.length; index += 1) {
        const path = join(dir, backups[index].entry)
        if (index === 0 && !liveExists) {
          try {
            await rename(path, live)
          } catch (error) {
            throw new Error(
              `Failed to recover interrupted Skill package update for "${directoryName}" from backup ${backups[index].entry}: ${String(error)}`
            )
          }
          log.warn('recovered interrupted Skill package update from backup', { directoryName })
        } else {
          await rm(path, { recursive: true, force: true }).catch((error) =>
            log.warn('failed to remove leftover skill backup', {
              entry: backups[index].entry,
              error
            })
          )
        }
      }
    }

    for (const entry of stagings) {
      await rm(join(dir, entry), { recursive: true, force: true }).catch(() => {})
    }
  }
}
