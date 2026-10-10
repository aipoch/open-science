/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type {
  SessionReproducibilityCommand,
  SessionReproducibilityBatch
} from '../../shared/session-reproducibility'
import { sessionReproducibilityCommandSchema } from '../../shared/session-reproducibility'

import type {
  ArtifactEnvironmentLockBundleInfo,
  ArtifactReproducibilityOutputPreview,
  ArtifactReproducibilityReceiptScope,
  ArtifactReproducibilityOutputStorage,
  ReadArtifactReproducibilityOutputRequest,
  ArtifactReproducibilityCheckRequest,
  ArtifactReproducibilityCheckState,
  CancelArtifactReproducibilityCheckRequest,
  CreateArtifactEnvironmentFromLockRequest,
  CreateArtifactEnvironmentFromLockResult,
  ExportArtifactEnvironmentLockRequest,
  ExportArtifactEnvironmentLockResult,
  ExportArtifactReproducibilityReceiptRequest,
  ExportArtifactReproducibilityReceiptResult,
  GetArtifactReproducibilityCheckLogRequest,
  GetArtifactReproducibilityCheckRequest,
  ImportArtifactEnvironmentLockRequest,
  ImportArtifactEnvironmentLockResult,
  ListArtifactReproducibilityReceiptsRequest
} from '../../shared/artifact-reproducibility'
import type { ArtifactReproducibilityAttemptOwner } from './artifact-reproducibility-lifecycle'

import type { ApplicationCallerLease, ApplicationInvocation } from '../application-command-router'
import { requireDesktopCaller } from '../caller-context'
export type ArtifactReproducibilityCommandOwner = Pick<
  ArtifactReproducibilityAttemptOwner,
  | 'start'
  | 'cancel'
  | 'cancelOwner'
  | 'getCheck'
  | 'getCheckLog'
  | 'listReceipts'
  | 'sessionCommand'
>

export type ArtifactReproducibilityCommandDependencies = {
  outputStorage: (
    request: ArtifactReproducibilityReceiptScope
  ) => Promise<ArtifactReproducibilityOutputStorage>
  clearOutputs: (
    request: ArtifactReproducibilityReceiptScope
  ) => Promise<ArtifactReproducibilityOutputStorage>
  previewOutput: (
    request: ReadArtifactReproducibilityOutputRequest
  ) => Promise<ArtifactReproducibilityOutputPreview>
  withSessionAvailable: <Result>(
    request: Pick<ArtifactReproducibilityCheckRequest, 'projectId' | 'appSessionId'>,
    start: () => Promise<Result>
  ) => Promise<Result>
  describeEnvironmentLock: (
    request: ExportArtifactEnvironmentLockRequest
  ) => Promise<ArtifactEnvironmentLockBundleInfo>
  createEnvironmentFromLock: (
    request: CreateArtifactEnvironmentFromLockRequest
  ) => Promise<CreateArtifactEnvironmentFromLockResult>
  exportEnvironmentLock: (
    clientId: string,
    request: ExportArtifactEnvironmentLockRequest
  ) => Promise<ExportArtifactEnvironmentLockResult>
  exportReceipt: (
    clientId: string,
    request: ExportArtifactReproducibilityReceiptRequest
  ) => Promise<ExportArtifactReproducibilityReceiptResult>
  importEnvironmentLock: (
    clientId: string,
    request: ImportArtifactEnvironmentLockRequest
  ) => Promise<ImportArtifactEnvironmentLockResult>
}

// A document lease owns running checks. The service retains its numeric process-local owner key;
// Node documents use disjoint negative keys and never derive authority from renderer data.
let nextOwnerId = -1
export function createArtifactReproducibilityCommands(
  getOwner: () => ArtifactReproducibilityCommandOwner,
  dependencies: ArtifactReproducibilityCommandDependencies,
  report: (clientId: string, state: ArtifactReproducibilityCheckState) => void
) {
  const callers = new Map<ApplicationCallerLease, { id: number; release(): void }>()
  const callerFor = (invocation: ApplicationInvocation<readonly unknown[]>): number => {
    requireDesktopCaller(invocation.callerContext)
    const lease = invocation.callerLease
    if (lease.signal.aborted || !lease.isCurrent())
      throw new Error('Reproducibility check owner is unavailable.')
    let caller = callers.get(lease)
    if (!caller) {
      const legacyId = Number(invocation.callerContext.clientId)
      const id = Number.isSafeInteger(legacyId) && legacyId > 0 ? legacyId : nextOwnerId--
      caller = {
        id,
        release: () => {
          callers.delete(lease)
          lease.signal.removeEventListener('abort', caller!.release)
          getOwner().cancelOwner(id)
        }
      }
      callers.set(lease, caller)
      lease.signal.addEventListener('abort', caller.release, { once: true })
    }
    return caller.id
  }
  const publishFor =
    (invocation: ApplicationInvocation<readonly unknown[]>) =>
    (state: ArtifactReproducibilityCheckState): void => {
      if (!invocation.callerLease.signal.aborted && invocation.callerLease.isCurrent())
        report(invocation.callerContext.clientId, state)
    }
  const assertScope = (value: ArtifactReproducibilityReceiptScope): void => {
    const keys: Array<keyof ArtifactReproducibilityReceiptScope> = [
      'projectId',
      'appSessionId',
      'artifactId',
      'versionId'
    ]
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      keys.some((key) => typeof value[key] !== 'string' || !value[key].trim())
    )
      throw new Error('Invalid reproduced output scope.')
  }
  return {
    sessionCommand: (
      invocation: ApplicationInvocation<readonly [SessionReproducibilityCommand]>
    ): Promise<SessionReproducibilityBatch | undefined> => {
      const request = sessionReproducibilityCommandSchema.parse(invocation.args[0])
      callerFor(invocation)
      const invoke = async (): Promise<SessionReproducibilityBatch | undefined> =>
        getOwner().sessionCommand(request, callerFor(invocation), publishFor(invocation))
      return request.action === 'prepare' || request.action === 'start'
        ? dependencies.withSessionAvailable(request, invoke)
        : invoke()
    },
    outputStorage: (
      invocation: ApplicationInvocation<readonly [ArtifactReproducibilityReceiptScope]>
    ) => {
      requireDesktopCaller(invocation.callerContext)
      assertScope(invocation.args[0])
      return dependencies.outputStorage(invocation.args[0])
    },
    clearOutputs: (
      invocation: ApplicationInvocation<readonly [ArtifactReproducibilityReceiptScope]>
    ) => {
      requireDesktopCaller(invocation.callerContext)
      assertScope(invocation.args[0])
      return dependencies.clearOutputs(invocation.args[0])
    },
    previewOutput: (
      invocation: ApplicationInvocation<readonly [ReadArtifactReproducibilityOutputRequest]>
    ) => {
      requireDesktopCaller(invocation.callerContext)
      return dependencies.previewOutput(invocation.args[0])
    },
    describeEnvironmentLock: (
      invocation: ApplicationInvocation<readonly [ExportArtifactEnvironmentLockRequest]>
    ) => {
      requireDesktopCaller(invocation.callerContext)
      return dependencies.describeEnvironmentLock(invocation.args[0])
    },
    createEnvironmentFromLock: (
      invocation: ApplicationInvocation<readonly [CreateArtifactEnvironmentFromLockRequest]>
    ) => {
      requireDesktopCaller(invocation.callerContext)
      return dependencies.createEnvironmentFromLock(invocation.args[0])
    },
    exportEnvironmentLock: (
      invocation: ApplicationInvocation<readonly [ExportArtifactEnvironmentLockRequest]>
    ) => {
      requireDesktopCaller(invocation.callerContext)
      return dependencies.exportEnvironmentLock(
        invocation.callerContext.clientId,
        invocation.args[0]
      )
    },
    exportReceipt: (
      invocation: ApplicationInvocation<readonly [ExportArtifactReproducibilityReceiptRequest]>
    ) => {
      requireDesktopCaller(invocation.callerContext)
      return dependencies.exportReceipt(invocation.callerContext.clientId, invocation.args[0])
    },
    importEnvironmentLock: (
      invocation: ApplicationInvocation<readonly [ImportArtifactEnvironmentLockRequest]>
    ) => {
      requireDesktopCaller(invocation.callerContext)
      return dependencies.importEnvironmentLock(
        invocation.callerContext.clientId,
        invocation.args[0]
      )
    },
    getCheck: (
      invocation: ApplicationInvocation<readonly [GetArtifactReproducibilityCheckRequest]>
    ) => getOwner().getCheck(invocation.args[0], callerFor(invocation)),
    getCheckLog: (
      invocation: ApplicationInvocation<readonly [GetArtifactReproducibilityCheckLogRequest]>
    ) => {
      requireDesktopCaller(invocation.callerContext)
      return getOwner().getCheckLog(invocation.args[0])
    },
    listReceipts: (
      invocation: ApplicationInvocation<readonly [ListArtifactReproducibilityReceiptsRequest]>
    ) => {
      requireDesktopCaller(invocation.callerContext)
      return getOwner().listReceipts(invocation.args[0])
    },
    start: (invocation: ApplicationInvocation<readonly [ArtifactReproducibilityCheckRequest]>) => {
      callerFor(invocation)
      return dependencies.withSessionAvailable(invocation.args[0], async () =>
        getOwner().start(invocation.args[0], callerFor(invocation), publishFor(invocation))
      )
    },
    cancel: (
      invocation: ApplicationInvocation<readonly [CancelArtifactReproducibilityCheckRequest]>
    ) => getOwner().cancel(invocation.args[0], callerFor(invocation)),
    dispose: (): void => {
      for (const caller of callers.values()) caller.release()
    }
  }
}
export type ArtifactReproducibilityCommands = ReturnType<
  typeof createArtifactReproducibilityCommands
>

export const artifactReproducibilityMethods = {
  'artifacts:session-reproducibility': 'sessionCommand',
  'artifacts:get-reproducibility-output-storage': 'outputStorage',
  'artifacts:clear-reproducibility-outputs': 'clearOutputs',
  'artifacts:read-reproducibility-output': 'previewOutput',
  'artifacts:describe-environment-lock': 'describeEnvironmentLock',
  'artifacts:create-environment-from-lock': 'createEnvironmentFromLock',
  'artifacts:export-environment-lock': 'exportEnvironmentLock',
  'artifacts:export-reproducibility-receipt': 'exportReceipt',
  'artifacts:import-environment-lock': 'importEnvironmentLock',
  'artifacts:get-reproducibility-check': 'getCheck',
  'artifacts:get-reproducibility-check-log': 'getCheckLog',
  'artifacts:list-reproducibility-receipts': 'listReceipts',
  'artifacts:start-reproducibility-check': 'start',
  'artifacts:cancel-reproducibility-check': 'cancel'
} as const
