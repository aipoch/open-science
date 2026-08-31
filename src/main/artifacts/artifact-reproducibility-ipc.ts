import type { WebContents } from 'electron'

import type {
  ArtifactEnvironmentLockBundleInfo,
  ArtifactReproducibilityOutputPreview,
  ArtifactReproducibilityReceiptScope,
  ArtifactReproducibilityOutputStorage,
  ReadArtifactReproducibilityOutputRequest,
  ArtifactReproducibilityCheckRequest,
  ArtifactReproducibilityCheckLogRecord,
  ArtifactReproducibilityCheckState,
  ArtifactReproducibilityReceiptPage,
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
import { ipcMainHandle } from '../ipc-handler-registry'
import type { ArtifactReproducibilityAttemptOwner } from './artifact-reproducibility-lifecycle'

type ArtifactReproducibilityIpcOwner = Pick<
  ArtifactReproducibilityAttemptOwner,
  'start' | 'cancel' | 'cancelOwner' | 'getCheck' | 'getCheckLog' | 'listReceipts'
>

type ArtifactReproducibilityIpcDependencies = {
  outputStorage: (
    request: ArtifactReproducibilityReceiptScope
  ) => Promise<ArtifactReproducibilityOutputStorage>
  clearOutputs: (
    request: ArtifactReproducibilityReceiptScope
  ) => Promise<ArtifactReproducibilityOutputStorage>
  previewOutput: (
    request: ReadArtifactReproducibilityOutputRequest
  ) => Promise<ArtifactReproducibilityOutputPreview>
  withSessionAvailable: (
    request: ArtifactReproducibilityCheckRequest,
    start: () => Promise<ArtifactReproducibilityCheckState>
  ) => Promise<ArtifactReproducibilityCheckState>
  describeEnvironmentLock: (
    request: ExportArtifactEnvironmentLockRequest
  ) => Promise<ArtifactEnvironmentLockBundleInfo>
  createEnvironmentFromLock: (
    request: CreateArtifactEnvironmentFromLockRequest
  ) => Promise<CreateArtifactEnvironmentFromLockResult>
  exportEnvironmentLock: (
    sender: WebContents,
    request: ExportArtifactEnvironmentLockRequest
  ) => Promise<ExportArtifactEnvironmentLockResult>
  exportReceipt: (
    sender: WebContents,
    request: ExportArtifactReproducibilityReceiptRequest
  ) => Promise<ExportArtifactReproducibilityReceiptResult>
  importEnvironmentLock: (
    sender: WebContents,
    request: ImportArtifactEnvironmentLockRequest
  ) => Promise<ImportArtifactEnvironmentLockResult>
}

const registerArtifactReproducibilityIpcHandlers = (
  owner: ArtifactReproducibilityIpcOwner,
  dependencies: ArtifactReproducibilityIpcDependencies
): void => {
  const observedRenderers = new WeakSet<WebContents>()
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
  ipcMainHandle(
    'artifacts:get-reproducibility-output-storage',
    (_event, request: ArtifactReproducibilityReceiptScope) => {
      assertScope(request)
      return dependencies.outputStorage(request)
    }
  )
  ipcMainHandle(
    'artifacts:clear-reproducibility-outputs',
    (_event, request: ArtifactReproducibilityReceiptScope) => {
      assertScope(request)
      return dependencies.clearOutputs(request)
    }
  )
  ipcMainHandle(
    'artifacts:read-reproducibility-output',
    (_event, request: ReadArtifactReproducibilityOutputRequest) =>
      dependencies.previewOutput(request)
  )

  ipcMainHandle(
    'artifacts:describe-environment-lock',
    (_event, request: ExportArtifactEnvironmentLockRequest) =>
      dependencies.describeEnvironmentLock(request)
  )
  ipcMainHandle(
    'artifacts:create-environment-from-lock',
    (_event, request: CreateArtifactEnvironmentFromLockRequest) =>
      dependencies.createEnvironmentFromLock(request)
  )
  ipcMainHandle(
    'artifacts:export-environment-lock',
    (event, request: ExportArtifactEnvironmentLockRequest) =>
      dependencies.exportEnvironmentLock(event.sender, request)
  )
  ipcMainHandle(
    'artifacts:export-reproducibility-receipt',
    (event, request: ExportArtifactReproducibilityReceiptRequest) =>
      dependencies.exportReceipt(event.sender, request)
  )
  ipcMainHandle(
    'artifacts:import-environment-lock',
    (event, request: ImportArtifactEnvironmentLockRequest) =>
      dependencies.importEnvironmentLock(event.sender, request)
  )
  ipcMainHandle(
    'artifacts:get-reproducibility-check',
    (
      event,
      request: GetArtifactReproducibilityCheckRequest
    ): ArtifactReproducibilityCheckState | undefined => owner.getCheck(request, event.sender.id)
  )
  ipcMainHandle(
    'artifacts:get-reproducibility-check-log',
    (
      _event,
      request: GetArtifactReproducibilityCheckLogRequest
    ): Promise<ArtifactReproducibilityCheckLogRecord | undefined> => owner.getCheckLog(request)
  )
  ipcMainHandle(
    'artifacts:list-reproducibility-receipts',
    (
      _event,
      request: ListArtifactReproducibilityReceiptsRequest
    ): Promise<ArtifactReproducibilityReceiptPage> => owner.listReceipts(request)
  )
  ipcMainHandle(
    'artifacts:start-reproducibility-check',
    (
      event,
      request: ArtifactReproducibilityCheckRequest
    ): Promise<ArtifactReproducibilityCheckState> => {
      const sender = event.sender
      const senderId = sender.id
      if (!observedRenderers.has(sender)) {
        observedRenderers.add(sender)
        sender.once('destroyed', () => owner.cancelOwner(senderId))
      }
      return dependencies.withSessionAvailable(request, async () => {
        if (sender.isDestroyed()) throw new Error('Reproducibility check owner is unavailable.')
        return owner.start(request, senderId, (state) => {
          if (!sender.isDestroyed()) sender.send('artifacts:reproducibility-check-changed', state)
        })
      })
    }
  )
  ipcMainHandle(
    'artifacts:cancel-reproducibility-check',
    (event, request: CancelArtifactReproducibilityCheckRequest): void => {
      owner.cancel(request, event.sender.id)
    }
  )
}

export { registerArtifactReproducibilityIpcHandlers }
export type { ArtifactReproducibilityIpcDependencies }
