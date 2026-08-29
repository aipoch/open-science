import { type Event as ElectronEvent, type IpcMainInvokeEvent } from 'electron'

import type { ApplicationCallerLease, ApplicationInvocation } from '../application-command-router'
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
import { resolveDataRoot, resolveStorageRoot } from '../storage-root'
import type { UploadCommandOwner } from './command-owner'
import { UploadRepository } from './repository'

// Uploads are data-class: they follow the configurable data root (defaults to the config root).
const createDefaultUploadRepository = (): UploadRepository =>
  new UploadRepository(resolveDataRoot(), {
    getClient: () => getProjectDbClient(resolveStorageRoot())
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
  const navigationBindings = new WeakMap<ApplicationCallerLease, () => void>()
  const bindElectronNavigationCleanup = (event: IpcMainInvokeEvent): void => {
    const lease = callerLeaseForEvent(event)
    if (callerContextForEvent(event).surface !== 'electron' || navigationBindings.has(lease)) return

    const releaseBinding = (): void => {
      if (navigationBindings.get(lease) !== releaseBinding) return
      navigationBindings.delete(lease)
      lease.signal.removeEventListener('abort', releaseBinding)
      event.sender.removeListener('did-start-navigation', releaseOnMainFrameNavigation)
    }
    const releaseOnMainFrameNavigation = (
      _navigationEvent: ElectronEvent,
      _url: string,
      _isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame) return
      releaseBinding()
      owner.releaseCaller(lease)
    }
    navigationBindings.set(lease, releaseBinding)
    lease.signal.addEventListener('abort', releaseBinding, { once: true })
    event.sender.on('did-start-navigation', releaseOnMainFrameNavigation)
    if (lease.signal.aborted || !lease.isCurrent()) {
      releaseBinding()
      throw new Error('Upload renderer is no longer available.')
    }
  }
  const invocationFor = <const Args extends readonly unknown[]>(
    event: IpcMainInvokeEvent,
    args: Args
  ): ApplicationInvocation<Args> => ({
    callerContext: callerContextForEvent(event),
    callerLease: callerLeaseForEvent(event),
    args
  })
  const ownedInvocationFor = <const Args extends readonly unknown[]>(
    event: IpcMainInvokeEvent,
    args: Args
  ): ApplicationInvocation<Args> => {
    bindElectronNavigationCleanup(event)
    return invocationFor(event, args)
  }

  ipcMainHandle('uploads:stage-local-file', (event, request: StageLocalUploadRequest) =>
    owner.stageLocalFile(ownedInvocationFor(event, [request]), {
      report: (progress) => event.sender.send('uploads:transfer-progress', progress)
    })
  )
  ipcMainHandle('uploads:claim-local-file', (event, request: UploadTransferRequest) =>
    owner.claimLocalFile(ownedInvocationFor(event, [request]))
  )
  ipcMainHandle('uploads:stage-local-path', async (event, request: StageLocalPathUploadRequest) => {
    const attachment = await owner.stageLocalPath(ownedInvocationFor(event, [request]), {
      report: (progress) => event.sender.send('uploads:transfer-progress', progress)
    })
    const projectId = request.projectId ?? DEFAULT_UPLOAD_PROJECT_ID
    options.onStandaloneUploadSaved?.(projectId, STANDALONE_UPLOAD_SESSION_ID)
    return attachment
  })
  ipcMainHandle('uploads:begin-transfer', (event, request: BeginUploadTransferRequest) =>
    owner.beginTransfer(ownedInvocationFor(event, [request]))
  )
  ipcMainHandle('uploads:append-transfer', (event, request: AppendUploadTransferRequest) =>
    owner.appendTransfer(ownedInvocationFor(event, [request]))
  )
  ipcMainHandle('uploads:transfer-status', (event, request: UploadTransferRequest) =>
    owner.transferStatus(ownedInvocationFor(event, [request]))
  )
  ipcMainHandle('uploads:finish-transfer', (event, request: UploadTransferRequest) =>
    owner.finishTransfer(ownedInvocationFor(event, [request]))
  )
  ipcMainHandle('uploads:abort-transfer', (event, request: UploadTransferRequest) =>
    owner.abortTransfer(ownedInvocationFor(event, [request]))
  )
  ipcMainHandle('uploads:delete', (event, request: DeleteUploadRequest) =>
    owner.deleteUpload(invocationFor(event, [request]))
  )
  ipcMainHandle('uploads:read-preview', (event, request: ReadArtifactPreviewRequest) =>
    owner.readPreview(invocationFor(event, [request]))
  )
}

export { createDefaultUploadRepository, registerUploadIpcHandlers }
