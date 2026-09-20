import { randomUUID } from 'node:crypto'
import { app, net, protocol, webContents } from 'electron'
import type { AcquireManagedPreviewRequest } from '../../shared/preview-resources'
import {
  OFFICE_PREVIEW_STATE_CHANNEL,
  type OfficePreviewOpenRequest
} from '../../shared/office-preview'
import {
  createOfficePreviewFrameProcessResolver,
  createOfficePreviewProcessMemoryReader
} from '../office-preview/office-preview-electron'
import { registerOfficePreviewIpcHandlers } from '../office-preview/office-preview-ipc'
import {
  createOfficePreviewRuntimeUrl,
  registerOfficePreviewRuntimeProtocol
} from '../office-preview/office-preview-runtime-protocol'
import { OfficePreviewSupervisor } from '../office-preview/office-preview-supervisor'
import type { ManagedPreviewResources } from '../managed-preview-resources'
import type { NamedElectronSurfaceAdapter } from '../runtime-electron-wiring'
import { createElectronSurfaceAdapter } from './adapter'

type Owners = {
  previewResources: Pick<ManagedPreviewResources, 'inspect' | 'acquire' | 'release'>
  runtimeHtmlPath: string
}

export const createOfficePreviewElectronSurfaces = ({
  previewResources,
  runtimeHtmlPath
}: Owners): NamedElectronSurfaceAdapter[] => {
  const runtimeSurface = createElectronSurfaceAdapter('office-preview-runtime', () =>
    registerOfficePreviewRuntimeProtocol(
      {
        runtimeHtmlPath,
        devServerUrl: process.env['ELECTRON_RENDERER_URL'],
        fetchRuntime: (targetUrl, request) =>
          net.fetch(targetUrl, {
            // Runtime assets are public application files. Forwarding custom-protocol headers or its
            // abort signal makes Chromium treat the local fetch as a cross-site renderer request.
            method: request.method
          })
      },
      protocol
    )
  )
  const toManagedPreviewRequest = (
    request: OfficePreviewOpenRequest
  ): AcquireManagedPreviewRequest =>
    request.source === 'notebook-input'
      ? { source: request.source, path: request.path }
      : {
          source: request.source,
          projectId: request.projectId,
          fileId: request.fileId,
          ...(request.versionId ? { versionId: request.versionId } : {})
        }
  const officePreviewSupervisor = new OfficePreviewSupervisor({
    inspectResource: (request) => previewResources.inspect(toManagedPreviewRequest(request)),
    acquireResource: (ownerId, request, snapshot, maxBytes) =>
      previewResources.acquire(ownerId, toManagedPreviewRequest(request), { snapshot, maxBytes }),
    releaseResource: (ownerId, resourceId) => previewResources.release(ownerId, { resourceId }),
    createSessionId: randomUUID,
    createRuntimeUrl: createOfficePreviewRuntimeUrl,
    resolveFrameProcess: createOfficePreviewFrameProcessResolver(webContents),
    getProcessMemoryUsageBytes: createOfficePreviewProcessMemoryReader(app),
    publishState: (ownerId, state) =>
      webContents.fromId(ownerId)?.send(OFFICE_PREVIEW_STATE_CHANNEL, state)
  })
  const previewSurface = createElectronSurfaceAdapter('office-preview', () =>
    registerOfficePreviewIpcHandlers(officePreviewSupervisor)
  )
  return [runtimeSurface, previewSurface]
}
