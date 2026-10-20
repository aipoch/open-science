import { renderReviewerDesktopResource } from './reviewer/paged-preview-electron'
import {
  createOfficePreviewFrameProcessResolver,
  createOfficePreviewProcessMemoryReader
} from './office-preview/office-preview-electron'
import { app, BrowserWindow, dialog, shell } from 'electron'
import type { WebContents } from 'electron'
import { writeFile, rm } from 'node:fs/promises'
import type { DesktopNativeHandler } from './desktop-native-contract'
import { desktopNativeRequestSchema } from './desktop-native-contract'
import { printConversationPdf } from './session-persistence/conversation-pdf-electron'

// Only the authenticated main-process connection reaches this handler. No renderer-facing native
// RPC is installed. A caller identity must still resolve to the current application document.
export function createDesktopNativeHandler(
  documentFor: (clientId: string) => WebContents | undefined,
  isApplicationWindow: (sender: WebContents) => boolean
): DesktopNativeHandler {
  return async (raw, signal) => {
    const { clientId, request } = desktopNativeRequestSchema.parse(raw)
    if (request.operation === 'reviewer-render') {
      signal.throwIfAborted()
      return renderReviewerDesktopResource({ ...request.input, signal })
    }
    const windowFor = (): BrowserWindow | undefined => {
      signal.throwIfAborted()
      const sender =
        clientId === undefined
          ? BrowserWindow.getAllWindows().find(
              (window) => !window.isDestroyed() && isApplicationWindow(window.webContents)
            )?.webContents
          : documentFor(clientId)
      if (!sender || sender.isDestroyed() || !isApplicationWindow(sender))
        throw new Error('Desktop command window is no longer available.')
      const parent = BrowserWindow.fromWebContents(sender)
      if (!parent || parent.isDestroyed())
        throw new Error('Desktop command window is no longer available.')
      return parent
    }
    const parent = windowFor()!
    let result: unknown
    switch (request.operation) {
      case 'office-frame':
        result =
          createOfficePreviewFrameProcessResolver({
            fromId: (id) => (id === parent.webContents.id ? parent.webContents : undefined)
          })(parent.webContents.id, request.runtimeUrl) ?? null
        break
      case 'process-memory':
        result = createOfficePreviewProcessMemoryReader(app)(request.processId)
        break
      case 'open-path':
        result = await shell.openPath(request.path)
        break
      case 'reveal-path':
        shell.showItemInFolder(request.path)
        result = null
        break
      case 'open-external':
        await shell.openExternal(request.url)
        result = null
        break
      case 'open-dialog': {
        const selected = await dialog.showOpenDialog(parent, request.options)
        result = { canceled: selected.canceled, filePaths: selected.filePaths }
        break
      }
      case 'save-dialog': {
        const selected = await dialog.showSaveDialog(parent, request.options)
        result = {
          canceled: selected.canceled,
          ...(selected.filePath ? { filePath: selected.filePath } : {})
        }
        break
      }
      case 'message-box': {
        const selected = await dialog.showMessageBox(parent, { ...request.options, signal })
        result = { response: selected.response }
        break
      }
      case 'conversation-pdf': {
        const pdf = await printConversationPdf(request, undefined, signal)
        windowFor()
        const output = `${request.htmlPath}.pdf`
        await writeFile(output, pdf, { flag: 'wx', mode: 0o600 })
        try {
          windowFor()
        } catch (error) {
          await rm(output, { force: true })
          throw error
        }
        result = output
        break
      }
      default:
        throw new Error('Unsupported native file operation.')
    }
    // Native open/save dialogs cannot be dismissed programmatically on every platform. Discard any
    // late selection after navigation, document release or transport loss; never publish with it.
    windowFor()
    return result
  }
}
