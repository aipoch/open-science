import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SpecialistPackageValidationPlan } from '../../../shared/specialist-package'
import type { SpecialistProfileView } from '../../../shared/specialist'
import { emptyFullAccessConfig } from '../../../shared/specialist'
import { createLogger } from '../../logger'
import { SpecialistRepository } from '../repository'
import { SPECIALISTS_FILE_VERSION, type StoredSpecialist, type StoredSpecialists } from '../types'
import { specialistContentModifiedSinceImport, specialistPayloadContentHash } from './validator'
import { NOOP_SPECIALIST_PACKAGE_SKILL_PORT, type SpecialistPackageSkillPort } from './skill-port'

type TransactionPhase = 'prepared' | 'committing' | 'committed' | 'rolling-back' | 'rolled-back'

type TransactionJournal = {
  transactionId: string
  phase: TransactionPhase
  specialistId: string
  beforeDigest: string
  afterDigest: string
  // Legacy journals embedded documents. New journals keep sensitive Specialist payloads in
  // transaction data sidecars and contain only IDs, digests, and phase metadata.
  before?: StoredSpecialists
  after?: StoredSpecialists
}

const log = createLogger('specialist.package.transaction')

const documentDigest = (document: StoredSpecialists): string =>
  createHash('sha256').update(JSON.stringify(document)).digest('hex')

export class SpecialistPackageRecoveryError extends Error {
  constructor() {
    super('Specialist package recovery failed; package mutations are blocked.')
    this.name = 'SpecialistPackageRecoveryError'
  }
}

export class SpecialistPackageRevisionConflictError extends Error {}
export class SpecialistPackageRollbackError extends Error {}

const toView = (stored: StoredSpecialist): SpecialistProfileView => ({
  ...stored,
  displayName: stored.displayName ?? stored.name,
  modifiedSinceImport:
    stored.origin === 'imported' && stored.importBaseline !== undefined
      ? specialistContentModifiedSinceImport({ ...stored, importBaseline: stored.importBaseline })
      : false
})

export class SpecialistPackageTransaction {
  private readonly journalPath: string
  private readonly beforeDataPath: string
  private readonly afterDataPath: string
  private queue: Promise<void> = Promise.resolve()
  private recoveryFailure: unknown

  constructor(
    storageDir: string,
    private readonly repository: SpecialistRepository,
    private readonly transactionId: () => string = randomUUID,
    private readonly skillPort: SpecialistPackageSkillPort = NOOP_SPECIALIST_PACKAGE_SKILL_PORT
  ) {
    this.journalPath = join(storageDir, 'specialist-package-transaction.json')
    this.beforeDataPath = join(storageDir, 'specialist-package-transaction.before.json')
    this.afterDataPath = join(storageDir, 'specialist-package-transaction.after.json')
  }

  async recover(): Promise<void> {
    if (this.recoveryFailure) throw new SpecialistPackageRecoveryError()
    let raw: string
    try {
      raw = await readFile(this.journalPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await this.skillPort.recover(undefined, 'rollback')
          await this.cleanupTransactionData()
        } catch (recoveryError) {
          this.recoveryFailure = recoveryError
          throw new SpecialistPackageRecoveryError()
        }
        return
      }
      this.recoveryFailure = error
      throw new SpecialistPackageRecoveryError()
    }

    try {
      const journal = JSON.parse(raw) as TransactionJournal
      if (!journal || typeof journal.transactionId !== 'string') {
        throw new Error('Invalid Specialist package transaction journal.')
      }
      const { before, after } = await this.readTransactionData(journal)
      const beforeDigest = journal.beforeDigest ?? documentDigest(before)
      const afterDigest = journal.afterDigest ?? documentDigest(after)
      if (journal.phase === 'committed') {
        const current = await this.repository.getAll()
        if (documentDigest(current) === beforeDigest) {
          await this.repository.replaceAllIfUnchanged(before, after)
        } else if (documentDigest(current) !== afterDigest) {
          throw new Error('Specialist document changed after package commit.')
        }
        await this.skillPort.recover(journal.transactionId, 'commit')
      } else if (journal.phase !== 'rolled-back') {
        await this.skillPort.recover(journal.transactionId, 'rollback')
        const current = await this.repository.getAll()
        if (documentDigest(current) === afterDigest) {
          await this.repository.replaceAllIfUnchanged(after, before)
        } else if (documentDigest(current) !== beforeDigest) {
          throw new Error('Specialist document changed before package rollback.')
        }
      }
      await this.cleanupTransactionData()
      log.info('recovered specialist package transaction', {
        transactionId: journal.transactionId,
        specialistId: journal.specialistId
      })
    } catch (error) {
      this.recoveryFailure = error
      throw new SpecialistPackageRecoveryError()
    }
  }

  install(
    plan: Readonly<SpecialistPackageValidationPlan>,
    importedAt: Date,
    archiveDigest: string,
    overwrite?: { expectedRevision: number },
    assertApprovedImpact?: (document: Readonly<StoredSpecialists>) => Promise<void>,
    options?: { activateAfterInstall?: boolean }
  ): Promise<SpecialistProfileView> {
    const run = this.queue.then(async () => {
      await this.recover()
      const before = await this.repository.getAll()
      const existingIndex = before.specialists.findIndex(
        (specialist) => specialist.id === plan.specialistId
      )
      const existing = existingIndex < 0 ? undefined : before.specialists[existingIndex]
      if (overwrite) {
        if (!existing || existing.revision !== overwrite.expectedRevision) {
          throw new SpecialistPackageRevisionConflictError()
        }
      } else if (existing) throw new SpecialistPackageRevisionConflictError()
      const stored: StoredSpecialist = {
        id: plan.specialistId,
        name: plan.payload.name,
        displayName: plan.payload.displayName ?? plan.payload.name,
        description: plan.payload.description,
        systemPrompt: plan.payload.systemPrompt,
        enabled: options?.activateAfterInstall ? (existing?.enabled ?? true) : false,
        setupPending: options?.activateAfterInstall ? false : true,
        capabilityMode: 'selected',
        fullAccess: emptyFullAccessConfig(),
        selectedCapabilities: {
          skillIds: [...new Set(plan.skillIds)],
          connectorIds: [...new Set(plan.connectorIds)],
          connectorTools: []
        },
        revision: existing ? existing.revision + 1 : 1,
        packageVersion: plan.packageVersion,
        origin: 'imported',
        ownedSkillIds: [
          ...new Set([
            ...(existing?.ownedSkillIds ?? []),
            ...plan.skills
              .filter(
                (skill) =>
                  skill.disposition === 'install' ||
                  skill.disposition === 'reuse-owned' ||
                  skill.disposition === 'replace-existing'
              )
              .map((skill) => skill.localId ?? skill.id)
          ])
        ],
        importBaseline: {
          importedAt: importedAt.toISOString(),
          archiveDigest,
          contentDigest: '',
          packageContentDigest: plan.contentHash,
          packageVersion: plan.packageVersion
        }
      }
      stored.importBaseline!.contentDigest = specialistPayloadContentHash(stored)
      const after: StoredSpecialists = {
        version: SPECIALISTS_FILE_VERSION,
        specialists:
          existingIndex < 0
            ? [...before.specialists, stored]
            : before.specialists.map((specialist, index) =>
                index === existingIndex ? stored : specialist
              )
      }
      const transactionId = this.transactionId()
      const journal: TransactionJournal = {
        transactionId,
        phase: 'prepared',
        specialistId: stored.id,
        beforeDigest: documentDigest(before),
        afterDigest: documentDigest(after)
      }

      let specialistCommitted = false
      let skillMutationBegun = false

      try {
        await this.skillPort.prepare(
          transactionId,
          plan.specialistId,
          plan.skills.filter(
            (skill) =>
              skill.disposition === 'install' ||
              skill.disposition === 'reuse-owned' ||
              skill.disposition === 'replace-existing'
          )
        )
        await this.writeTransactionData(before, after)
        await this.writeJournal(journal)
        journal.phase = 'committing'
        await this.writeJournal(journal)
        await this.skillPort.beginMutation?.(transactionId, plan.specialistId, plan.skills)
        skillMutationBegun = true
        const commit = async (): Promise<void> => {
          await assertApprovedImpact?.(before)
          await this.repository.replaceAllIfUnchanged(before, after)
          specialistCommitted = true
          await this.skillPort.commit(transactionId)
          journal.phase = 'committed'
          await this.writeJournal(journal)
          await this.skillPort.recover(transactionId, 'commit')
          await this.cleanupTransactionData()
          log.info('committed specialist package transaction', {
            transactionId: journal.transactionId,
            specialistId: stored.id
          })
        }
        await (this.skillPort.runInMutationContext?.(transactionId, commit) ?? commit())
        return toView(stored)
      } catch (error) {
        try {
          journal.phase = 'rolling-back'
          await this.writeJournal(journal)
          await this.skillPort.rollback(transactionId)
          if (specialistCommitted) {
            await this.repository.replaceAllIfUnchanged(after, before)
          }
          journal.phase = 'rolled-back'
          await this.writeJournal(journal)
          await this.cleanupTransactionData()
        } catch (recoveryError) {
          this.recoveryFailure = recoveryError
          throw new SpecialistPackageRollbackError()
        }
        throw error
      } finally {
        if (skillMutationBegun) await this.skillPort.endMutation?.(transactionId)
      }
    })
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  deleteSpecialist(
    specialistId: string,
    expectedRevision: number,
    deleteSkillIds: readonly string[],
    assertDeletionAllowed?: () => Promise<void>
  ): Promise<void> {
    const run = this.queue.then(async () => {
      await this.recover()
      const before = await this.repository.getAll()
      const existing = before.specialists.find((specialist) => specialist.id === specialistId)
      if (!existing || existing.revision !== expectedRevision) {
        throw new SpecialistPackageRevisionConflictError()
      }
      const after: StoredSpecialists = {
        version: SPECIALISTS_FILE_VERSION,
        specialists: before.specialists.filter((specialist) => specialist.id !== specialistId)
      }
      const transactionId = this.transactionId()
      const journal: TransactionJournal = {
        transactionId,
        phase: 'prepared',
        specialistId,
        beforeDigest: documentDigest(before),
        afterDigest: documentDigest(after)
      }
      let specialistCommitted = false
      let skillMutationBegun = false
      try {
        await this.skillPort.beginMutation?.(transactionId, specialistId, [])
        skillMutationBegun = true
        const commit = async (): Promise<void> => {
          await assertDeletionAllowed?.()
          await this.skillPort.prepareDeletion?.(
            transactionId,
            specialistId,
            existing.ownedSkillIds,
            deleteSkillIds
          )
          await this.writeTransactionData(before, after)
          await this.writeJournal(journal)
          journal.phase = 'committing'
          await this.writeJournal(journal)
          await this.repository.replaceAllIfUnchanged(before, after)
          specialistCommitted = true
          await this.skillPort.commit(transactionId)
          journal.phase = 'committed'
          await this.writeJournal(journal)
          await this.skillPort.recover(transactionId, 'commit')
          await this.cleanupTransactionData()
        }
        await (this.skillPort.runInMutationContext?.(transactionId, commit) ?? commit())
      } catch (error) {
        try {
          journal.phase = 'rolling-back'
          await this.writeJournal(journal)
          await this.skillPort.rollback(transactionId)
          if (specialistCommitted) {
            await this.repository.replaceAllIfUnchanged(after, before)
          }
          journal.phase = 'rolled-back'
          await this.writeJournal(journal)
          await this.cleanupTransactionData()
        } catch (recoveryError) {
          this.recoveryFailure = recoveryError
          throw new SpecialistPackageRollbackError()
        }
        throw error
      } finally {
        if (skillMutationBegun) await this.skillPort.endMutation?.(transactionId)
      }
    })
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async writeJournal(journal: TransactionJournal): Promise<void> {
    const temporary = `${this.journalPath}.tmp`
    await writeFile(temporary, `${JSON.stringify(journal)}\n`, 'utf8')
    await rename(temporary, this.journalPath)
  }

  private async writeTransactionData(
    before: StoredSpecialists,
    after: StoredSpecialists
  ): Promise<void> {
    await writeFile(this.beforeDataPath, `${JSON.stringify(before)}\n`, 'utf8')
    await writeFile(this.afterDataPath, `${JSON.stringify(after)}\n`, 'utf8')
  }

  private async readTransactionData(
    journal: TransactionJournal
  ): Promise<{ before: StoredSpecialists; after: StoredSpecialists }> {
    const before =
      journal.before ??
      (JSON.parse(await readFile(this.beforeDataPath, 'utf8')) as StoredSpecialists)
    const after =
      journal.after ?? (JSON.parse(await readFile(this.afterDataPath, 'utf8')) as StoredSpecialists)
    if (
      (typeof journal.beforeDigest === 'string' &&
        documentDigest(before) !== journal.beforeDigest) ||
      (typeof journal.afterDigest === 'string' && documentDigest(after) !== journal.afterDigest)
    ) {
      throw new Error('Specialist package transaction data digest mismatch.')
    }
    return { before, after }
  }

  private async cleanupTransactionData(): Promise<void> {
    await Promise.all([
      rm(this.journalPath, { force: true }),
      rm(this.beforeDataPath, { force: true }),
      rm(this.afterDataPath, { force: true })
    ])
  }
}
