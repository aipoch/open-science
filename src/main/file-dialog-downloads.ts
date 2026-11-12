import {
  app,
  dialog,
  type BrowserWindow,
  type DownloadItem,
  type Event,
  type WebContents
} from 'electron'
import { mkdtempSync } from 'node:fs'
import { copyFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createLogger, startDiagnosticOperation } from '@aipoch/diagnostics/node'
import { showSaveDialog } from './file-dialog-electron'
import { publishUserFile } from './user-file-publisher'
import type { NativeTranslator } from './locale/main-process-messages'

// Browser-generated exports (including recovery diagnostics) must not open Chromium's native
// save dialog. Stage bytes locally and use the same isolated picker without requiring the backend.
export function installFileDialogDownloads(
  window: BrowserWindow,
  translate: NativeTranslator
): void {
  const session = window.webContents.session
  const log = createLogger('file-download')
  const onDownload = (event: Event, item: DownloadItem, contents: WebContents): void => {
    if (contents !== window.webContents) return
    const operation = startDiagnosticOperation(log, { operation: 'browser-file-download' })
    let root: string | undefined
    try {
      root = mkdtempSync(join(app.getPath('temp'), 'open-science-download-'))
      // This must be synchronous in will-download, before Chromium chooses its own save UI.
      item.setSavePath(join(root, 'download'))
    } catch (error) {
      event.preventDefault()
      operation.fail(error)
      if (root) void rm(root, { recursive: true, force: true }).catch(() => undefined)
      return
    }
    const stagedRoot = root
    let downloadFinished = false
    const cancelDownload = (): void => {
      if (!downloadFinished) item.cancel()
    }
    const controller = new AbortController()
    const closed = (): void => {
      controller.abort()
      cancelDownload()
    }
    window.once('closed', closed)
    const completed = new Promise<void>((resolve, reject) => {
      item.once('done', (_event, state) => {
        downloadFinished = true
        if (state === 'completed') resolve()
        else reject(new Error('Browser download did not complete.'))
      })
    })
    void completed.catch(() => undefined)
    void (async () => {
      try {
        const selected = await showSaveDialog(
          window,
          { defaultPath: basename(item.getFilename()) },
          controller.signal
        )
        if (selected.canceled || !selected.filePath) {
          operation.cancel()
          return
        }
        await completed
        controller.signal.throwIfAborted()
        await publishUserFile(selected.filePath, (target) =>
          copyFile(join(stagedRoot, 'download'), target)
        )
        operation.complete()
      } catch (error) {
        if (controller.signal.aborted) operation.cancel()
        else {
          operation.fail(error)
          if (!window.isDestroyed())
            await dialog.showMessageBox(window, {
              type: 'error',
              message: translate('Download failed')
            })
        }
      } finally {
        window.removeListener('closed', closed)
        cancelDownload()
        await completed.catch(() => undefined)
        await rm(stagedRoot, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200
        }).catch(() => log.warn('download cleanup deferred'))
      }
    })().catch((error) => log.error('download cleanup failed', error))
  }
  session.on('will-download', onDownload)
  window.once('closed', () => session.removeListener('will-download', onDownload))
}
