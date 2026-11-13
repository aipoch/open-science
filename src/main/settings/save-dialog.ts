import { BrowserWindow, type SaveDialogOptions, type WebContents } from 'electron'
import type { FileDialogSaveResult } from '../file-dialog-protocol'
import { showSaveDialog } from '../file-dialog-electron'

// Resolve the invoking window; the shared dialog adapter selects the platform's owner policy.
export const showSettingsSaveDialog = (
  sender: WebContents,
  options: SaveDialogOptions
): Promise<FileDialogSaveResult> => {
  const parentWindow = BrowserWindow.fromWebContents(sender)
  return parentWindow ? showSaveDialog(parentWindow, options) : showSaveDialog(options)
}
