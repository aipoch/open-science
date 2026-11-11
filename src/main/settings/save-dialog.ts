import {
  BrowserWindow,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
  type WebContents
} from 'electron'
import { showSaveDialog } from '../file-dialog-electron'

// Resolve the invoking window; the shared dialog adapter selects the platform's owner policy.
export const showSettingsSaveDialog = (
  sender: WebContents,
  options: SaveDialogOptions
): Promise<SaveDialogReturnValue> => {
  const parentWindow = BrowserWindow.fromWebContents(sender)
  return parentWindow ? showSaveDialog(parentWindow, options) : showSaveDialog(options)
}
