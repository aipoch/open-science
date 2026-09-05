import { randomUUID } from 'node:crypto'

import type { PackageMirror } from '../../shared/mirror'
import type { NotebookEnvironmentOperations } from './environment-operations'
import type {
  EnvironmentStateTracker,
  PackageMutationVerification
} from './environment-state-tracker'
import {
  operationJournalPath,
  recordOperationChildSync,
  recordSpawnIntentSync,
  removeOperationChildSync,
  RuntimeOperationJournal
} from './operation-journal'
import type { NotebookPackageAdmission, NotebookPackageAdmittedTarget } from './package-admission'
import type { InstallDeps, InstallResult, InstallSpawn } from './package-manager'
import type {
  MicromambaWorkingCacheRetainer,
  WorkingCacheArchivePublication
} from './windows-micromamba-working-cache'
import { prepareNotebookWorkloadCache } from './notebook-workload-cache-paths'
import { readProcessStartToken } from './operation-recovery'
import { isChildUnconfirmedError } from './provisioner-runtime'
import type { NotebookRuntimeRepairOwner } from './runtime-repair'
import type { MicromambaRunner } from './windows-micromamba-runner'

const REPAIR_QUARANTINE_FAILED = 'REPAIR_QUARANTINE_FAILED'
const CACHE_ARCHIVE_EVIDENCE_INCOMPLETE = 'CACHE_ARCHIVE_EVIDENCE_INCOMPLETE'

const isRepairQuarantineError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes(REPAIR_QUARANTINE_FAILED)

const isArchiveEvidenceIncompleteError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes(CACHE_ARCHIVE_EVIDENCE_INCOMPLETE)

type NotebookPackageMutationInput = Readonly<{
  target: NotebookPackageAdmittedTarget
  mirror: PackageMirror
}>

type NotebookPackageMutationOwnerOptions = {
  storageRoot: string
  runtimeRoot: string
  environmentOperations: Pick<
    NotebookEnvironmentOperations,
    'runMutation' | 'logPackageFailure' | 'logPackageResult'
  >
  environmentStateTracker: Pick<
    EnvironmentStateTracker,
    'markPackageMutationDirty' | 'refreshAfterPackageMutation'
  >
  installPackages: (
    request: NotebookPackageAdmittedTarget['request'],
    deps?: Partial<InstallDeps>
  ) => Promise<InstallResult>
  packageSpawn?: (target: NotebookPackageAdmittedTarget) => InstallSpawn
  micromambaRunner?: Pick<MicromambaRunner, 'resolve'>
  recheckRepair: (
    target: NotebookPackageAdmittedTarget
  ) => Extract<NotebookPackageAdmission, { status: 'refused' }> | undefined
  runtimeRepair: Pick<
    NotebookRuntimeRepairOwner,
    'quarantineProtectedIdentity' | 'completeInterruptedInstall'
  >
  blockUnconfirmedChild: (target: NotebookPackageAdmittedTarget) => void
  retainWorkingCache?: MicromambaWorkingCacheRetainer
}

/** Owns the complete crash-recoverable transaction for one admitted package mutation. */
class NotebookPackageMutationOwner {
  constructor(private readonly options: NotebookPackageMutationOwnerOptions) {}

  async mutate({ target, mirror }: NotebookPackageMutationInput): Promise<InstallResult> {
    const {
      environmentCaptureTarget,
      environmentName,
      interpreter,
      journalTarget,
      repairMarkerKey,
      repairRuntimeId,
      request
    } = target
    const { runtimeRoot } = this.options
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    const operationId = randomUUID()
    const archiveCacheTransaction =
      journalTarget !== undefined &&
      this.options.retainWorkingCache !== undefined &&
      request.usePip !== true &&
      request.installer === undefined
    const releaseWorkingCache = archiveCacheTransaction
      ? await this.options.retainWorkingCache?.(runtimeRoot, operationId)
      : undefined
    let result: InstallResult | undefined
    let retainForRecovery = false
    let begun = false
    let publicationIntentPersisted = false
    let archiveEvidenceIncomplete = false
    const archivePublications = new Map<string, WorkingCacheArchivePublication>()
    try {
      // The journal begins inside the environment lock so Reset cannot clear this new operation
      // between intent recording and the first installer spawn.
      await this.options.environmentOperations.runMutation(environmentName, async () => {
        const repairRefusal = this.options.recheckRepair(target)
        if (repairRefusal) {
          result = repairRefusal.result
          return result
        }
        await journal.begin({
          operationId,
          kind: 'install',
          runtimeId: repairMarkerKey,
          phase: `install-${request.language}`,
          startedAt: Date.now(),
          targetPath: journalTarget,
          repairReason: 'interrupted-install',
          archivePublicationPending: archiveCacheTransaction ? true : undefined
        })
        begun = true
        prepareNotebookWorkloadCache(runtimeRoot)
        const mutation = {
          operationId,
          operation: request.operation ?? ('install' as const),
          packages: request.packages
        }
        // A durable dirty marker is required before spawn so a crash cannot leave stale inventory
        // presented as a clean environment snapshot.
        await this.options.environmentStateTracker.markPackageMutationDirty(
          environmentCaptureTarget,
          mutation
        )
        let installResult: InstallResult | undefined
        let deferredQuarantineError: Error | undefined
        const installerStartedAt = Date.now()
        let installerDurationMs = 0
        try {
          try {
            installResult = await this.options.installPackages(request, {
              ...(this.options.packageSpawn ? { spawn: this.options.packageSpawn(target) } : {}),
              micromambaRunner: this.options.micromambaRunner,
              storageRoot: this.options.storageRoot,
              condaChannel: mirror.condaChannel,
              pypiIndex: mirror.pypiIndex,
              cranMirror: mirror.cranMirror,
              caBundle: mirror.caBundle,
              interpreter,
              // Re-arm before every installer spawn. A later spawn intent must supersede an earlier PID
              // so recovery never treats the operation as stopped while another child may be starting.
              onBeforeSpawn: () => recordSpawnIntentSync(runtimeRoot, operationId),
              onChild: (childPid) => {
                const childStartedAt = Date.now()
                const childStartToken = readProcessStartToken(childPid)
                recordOperationChildSync(runtimeRoot, operationId, {
                  childPid,
                  childStartedAt,
                  childStartToken
                })
                void journal
                  .update(operationId, { childPid, childStartedAt, childStartToken })
                  .catch(() => undefined)
              },
              onCacheMaintenanceSettled: async () => {
                // Cache cleanup reuses this operation's recovery barrier while its child is alive, but
                // it is not the installer transaction. Clear its settled identity before a dry-run or
                // real install can begin so a crash in that gap cannot be recovered as an interrupted
                // package mutation. Awaiting update also serializes behind the fire-and-forget PID write.
                await journal.update(operationId, {
                  childPid: undefined,
                  childStartedAt: undefined,
                  childStartToken: undefined
                })
                removeOperationChildSync(runtimeRoot, operationId)
              },
              onCondaArchiveAuthorizations: (authorizations, workingRoot, evidenceComplete) => {
                if (evidenceComplete === false) archiveEvidenceIncomplete = true
                if (authorizations.length === 0) return
                const previous = archivePublications.get(workingRoot)
                archivePublications.set(workingRoot, {
                  workingRoot,
                  authorizations: [...(previous?.authorizations ?? []), ...authorizations]
                })
              }
            })
            installerDurationMs = Date.now() - installerStartedAt
          } catch (error) {
            this.options.environmentOperations.logPackageFailure({
              operationId,
              operation: mutation.operation,
              language: request.language,
              environmentName,
              runtimeSource: environmentCaptureTarget.runtimeSource,
              packages: request.packages,
              error,
              durationMs: Date.now() - installerStartedAt
            })
            throw error
          }
        } finally {
          let inventoryRefreshError: unknown
          const verification: PackageMutationVerification | undefined =
            await this.options.environmentStateTracker
              .refreshAfterPackageMutation(environmentCaptureTarget, {
                ...mutation,
                result: installResult?.ok ? 'success' : 'failure',
                attempts: installResult?.attempts ?? [],
                fallbackUsed: installResult?.fallbackUsed ?? false,
                ...(installResult?.source ? { source: installResult.source } : {})
              })
              .catch((error: unknown) => {
                inventoryRefreshError = error
                return { result: 'failure' as const, reason: 'inventory-refresh-failed' as const }
              })
          if (installResult && verification?.packageChanges) {
            installResult = {
              ...installResult,
              packageChanges: verification.packageChanges.map((change) =>
                change.relationship === 'requested' && installResult?.source && !change.source
                  ? { ...change, source: installResult.source }
                  : change
              )
            }
          }
          if (installResult && request.language === 'r' && !installResult.repairRequired) {
            // Batch satisfaction and a live R namespace's freshness are independent. A failed
            // installer may already have changed packages even when inventory cannot prove a delta.
            // Protected-identity failures require repair and terminate the kernel; retain the
            // installer's repair-only guidance rather than inferring advice for that dead kernel.
            installResult = {
              ...installResult,
              needsRestart:
                installResult.needsRestart ||
                Boolean(
                  installResult.packageChanges?.some((change) =>
                    ['installed', 'updated', 'removed'].includes(change.change)
                  ) ||
                  installResult.attempts?.some(
                    (attempt) => attempt.status !== 'skipped' && attempt.mutationRisk !== 'none'
                  )
                )
            }
          }
          if (installResult?.ok && verification?.result === 'failure') {
            const packages =
              verification.unsatisfiedPackages?.join(', ') || request.packages.join(', ')
            const inventoryFailure =
              verification.reason === 'inventory-refresh-failed' || inventoryRefreshError
            installResult = {
              ...installResult,
              ok: false,
              error: inventoryFailure
                ? `Package installation could not be verified in the target runtime: ${packages}. ` +
                  'The installer exited successfully, but the environment inventory refresh failed.'
                : `Package installation could not be verified in the target runtime: ${packages}. ` +
                  'The installer exited successfully, but the refreshed environment inventory does not show the requested package(s).'
            }
          }
          // Publish the strong repair reason before quarantine and before releasing the environment
          // lock. Retain both journal and sidecar unless the durable gate is fully established.
          if (installResult?.repairRequired) {
            retainForRecovery = true
            let journalUpdateError: unknown
            try {
              await journal.update(operationId, {
                runtimeId: repairRuntimeId,
                repairReason: 'protected-identity-change'
              })
            } catch (error) {
              journalUpdateError = error
            }
            await this.options.runtimeRepair.quarantineProtectedIdentity(target)
            if (journalUpdateError) {
              deferredQuarantineError = new Error(
                `${REPAIR_QUARANTINE_FAILED}: the runtime was quarantined, but its operation journal ` +
                  `could not be upgraded to the protected-identity reason. ${
                    journalUpdateError instanceof Error
                      ? journalUpdateError.message
                      : String(journalUpdateError)
                  }`,
                { cause: journalUpdateError }
              )
            } else {
              retainForRecovery = false
            }
          }
        }
        if (deferredQuarantineError) throw deferredQuarantineError
        if (installResult) {
          this.options.environmentOperations.logPackageResult({
            operationId,
            operation: mutation.operation,
            language: request.language,
            environmentName,
            runtimeSource: environmentCaptureTarget.runtimeSource,
            packages: request.packages,
            result: installResult,
            durationMs: installerDurationMs
          })
        }
        const publications = installResult?.ok ? [...archivePublications.values()] : []
        // Publish from this settled result even if the lock wrapper itself fails while unwinding after
        // the callback returns. Otherwise the outer assignment never lands and finally could mistake a
        // committed transaction for an empty publication set.
        result = installResult
        if (archiveCacheTransaction && archiveEvidenceIncomplete) {
          retainForRecovery = true
          throw new Error(
            `${CACHE_ARCHIVE_EVIDENCE_INCOMPLETE}: micromamba completed, but its complete archive ` +
              'authorization set could not be captured; retaining the cache for explicit recovery'
          )
        }
        // Close the pre-mutation crash marker while still holding the environment lock. A successful
        // transaction records exact immutable authority; every other settled result records that there
        // is nothing to publish. The cache cannot be released until this atomic transition is durable.
        await journal.update(operationId, {
          childPid: undefined,
          childStartedAt: undefined,
          childStartToken: undefined,
          archivePublicationPending: undefined,
          archivePublications: publications.length > 0 ? publications : undefined
        })
        publicationIntentPersisted = true
        return installResult
      })
    } catch (error) {
      if (!begun) {
        return {
          ok: false,
          needsRestart: false,
          log: '',
          error:
            'RUNTIME_JOURNAL_UNWRITABLE: could not record this install for crash recovery, so it was ' +
            `not started (installing without a recovery record could strand a worker process). ${
              error instanceof Error ? error.message : String(error)
            }`
        }
      }
      if (
        !publicationIntentPersisted &&
        archivePublications.size === 0 &&
        !isRepairQuarantineError(error) &&
        !isArchiveEvidenceIncompleteError(error) &&
        !isChildUnconfirmedError(error)
      ) {
        try {
          await journal.update(operationId, { archivePublicationPending: undefined })
          publicationIntentPersisted = true
        } catch {
          // Keep the durable ambiguity marker, target block, and working cache below.
        }
      }
      if (isRepairQuarantineError(error)) retainForRecovery = true
      if (isChildUnconfirmedError(error)) {
        retainForRecovery = true
        // The direct installer PID may already be gone while an unenumerated/reparented descendant
        // continues writing. Replace that stale identity with the existing no-verifiable-PID state so
        // startup recovery blocks instead of clearing the journal after probing only the dead parent.
        try {
          recordSpawnIntentSync(runtimeRoot, operationId)
        } catch {
          // Retain the prior sidecar + journal as the best durable evidence still available. The
          // in-process recovery block below remains authoritative for this app lifetime.
        }
        this.options.blockUnconfirmedChild(target)
      }
      throw error
    } finally {
      const publications = result?.ok ? [...archivePublications.values()] : []
      if (begun && !publicationIntentPersisted) {
        retainForRecovery = true
        this.options.blockUnconfirmedChild(target)
      }
      if (begun && !retainForRecovery) {
        removeOperationChildSync(runtimeRoot, operationId)
      }
      const cacheFinalized = await releaseWorkingCache?.({
        archivePublications: publications,
        completedOperationId: operationId,
        retainForRecovery
      }).catch(() => false)
      if (begun && !retainForRecovery && (publications.length === 0 || cacheFinalized)) {
        await journal.complete(operationId).catch(() => undefined)
      }
    }
    if (!result) throw new Error('package mutation completed without an installer result')
    if (result.ok) await this.options.runtimeRepair.completeInterruptedInstall(target)
    return result
  }
}

export { NotebookPackageMutationOwner }
