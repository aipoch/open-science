import { randomUUID } from 'node:crypto'
import { app, BrowserWindow } from 'electron'
import type { ManagedPreviewResources } from '../managed-preview-resources'
import { createOfficePreviewProcessMemoryReader } from '../office-preview/office-preview-electron'
import {
  createReviewerPagedPreviewRuntimeUrl,
  OFFICE_PREVIEW_RUNTIME_ORIGIN
} from '../office-preview/office-preview-runtime-protocol'
import { renderPdfPagePreviews } from '../uploads/attachment-media'
import { createReviewerPagedContentResolver } from './paged-preview-resolver'
import type { ReviewerPagedContentResolver } from './host-sdk'

export const createReviewerElectronPagedContentResolver = (
  previewResources: Pick<ManagedPreviewResources, 'acquireResolvedFile' | 'release'>
): ReviewerPagedContentResolver =>
  createReviewerPagedContentResolver({
    createWindow: () => {
      const previewWindow = new BrowserWindow({
        show: false,
        width: 1_024,
        height: 1_280,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          partition: 'reviewer-paged-preview'
        }
      })
      previewWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      previewWindow.webContents.on('will-navigate', (event, url) => {
        const target = new URL(url)
        const runtime = new URL(OFFICE_PREVIEW_RUNTIME_ORIGIN)
        if (target.protocol !== runtime.protocol || target.hostname !== runtime.hostname) {
          event.preventDefault()
        }
      })
      previewWindow.webContents.session.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false)
      )
      return previewWindow
    },
    createSessionId: randomUUID,
    createRuntimeUrl: createReviewerPagedPreviewRuntimeUrl,
    acquireResource: (
      ownerId,
      resolvedPath,
      filename,
      verifiedObservation,
      verifiedChecksum,
      maxBytes
    ) =>
      previewResources.acquireResolvedFile(
        ownerId,
        {
          path: resolvedPath,
          mimeType: filename.endsWith('.docx')
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          verifiedObservation,
          verifiedChecksum
        },
        maxBytes
      ),
    releaseResource: (ownerId, resourceId) => previewResources.release(ownerId, { resourceId }),
    renderPdfPages: renderPdfPagePreviews,
    getProcessMemoryUsageBytes: createOfficePreviewProcessMemoryReader(app)
  })
