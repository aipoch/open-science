import { type IpcMainInvokeEvent } from 'electron'

import type { ApplicationInvocation } from '../application-command-router'
import { callerContextForEvent } from '../caller-context'
import { callerLeaseForEvent } from '../caller-lifecycle'
import { ipcMainHandle } from '../ipc-handler-registry'

import type { ReadArtifactPreviewRequest } from '../../shared/artifacts'
import type {
  AppendUploadTransferRequest,
  BeginUploadTransferRequest,
  DeleteUploadRequest,
  StageLocalPathUploadRequest,
  StageLocalUploadRequest,
  UploadTransferRequest
} from '../../shared/uploads'
import { DEFAULT_UPLOAD_PROJECT_ID, STANDALONE_UPLOAD_SESSION_ID } from '../../shared/uploads'
import { getProjectDbClient } from '../projects/prisma-client'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import type { UploadCommandOwner } from './command-owner'
import { UploadRepository } from './repository'

// Uploads are data-class: they follow the configurable data root (defaults to the config root).
const createDefaultUploadRepository = (): UploadRepository =>
  new UploadRepository(resolveDataRoot(), {
    getClient: () => getProjectDbClient(resolveConfigRoot())
  })

// Registers the small upload IPC surface used by the renderer composer and preview panel.
const registerUploadIpcHandlers = (
  owner: UploadCommandOwner,
  options: {
    // Called after a standalone "Save as artifact" upload has been persisted to SQLite so
    // the caller can broadcast a project-files:changed event to the renderer.
    onStandaloneUploadSaved?: (projectId: string, sessionId: string) => void
  } = {}
): void => {
  const invocationFor = <const Args extends readonly unknown[]>(
    event: IpcMainInvokeEvent,
    args: Args
  ): ApplicationInvocation<Args> => ({
    callerContext: callerContextForEvent(event),
    callerLease: callerLeaseForEvent(event),
    args
  })

  ipcMainHandle('uploads:stage-local-file', (event, request: StageLocalUploadRequest) =>
    owner.stageLocalFile(invocationFor(event, [request]), {
      report: (progress) => event.sender.send('uploads:transfer-progress', progress)
    })
  )
  ipcMainHandle('uploads:claim-local-file', (event, request: UploadTransferRequest) =>
    owner.claimLocalFile(invocationFor(event, [request]))
  )
  ipcMainHandle('uploads:stage-local-path', async (event, request: StageLocalPathUploadRequest) => {
    const attachment = await owner.stageLocalPath(invocationFor(event, [request]), {
      report: (progress) => event.sender.send('uploads:transfer-progress', progress)
    })
    const projectId = request.projectId ?? DEFAULT_UPLOAD_PROJECT_ID
    options.onStandaloneUploadSaved?.(projectId, STANDALONE_UPLOAD_SESSION_ID)
    return attachment
  })
  ipcMainHandle('uploads:begin-transfer', (event, request: BeginUploadTransferRequest) =>
    owner.beginTransfer(invocationFor(event, [request]))
  )
  ipcMainHandle('uploads:append-transfer', (event, request: AppendUploadTransferRequest) =>
    owner.appendTransfer(invocationFor(event, [request]))
  )
  ipcMainHandle('uploads:transfer-status', (event, request: UploadTransferRequest) =>
    owner.transferStatus(invocationFor(event, [request]))
  )
  ipcMainHandle('uploads:finish-transfer', (event, request: UploadTransferRequest) =>
    owner.finishTransfer(invocationFor(event, [request]))
  )
  ipcMainHandle('uploads:abort-transfer', (event, request: UploadTransferRequest) =>
    owner.abortTransfer(invocationFor(event, [request]))
  )
  ipcMainHandle('uploads:delete', (event, request: DeleteUploadRequest) =>
    owner.deleteUpload(invocationFor(event, [request]))
  )
  ipcMainHandle('uploads:read-preview', (event, request: ReadArtifactPreviewRequest) =>
    owner.readPreview(invocationFor(event, [request]))
  )
}

export { createDefaultUploadRepository, registerUploadIpcHandlers }
