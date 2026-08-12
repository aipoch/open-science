import {
  BrowserWindow,
  dialog,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
  type WebContents
} from 'electron'

// Attach Settings exports to the window that invoked them so native confirmation and cancellation
// complete within the same modal lifecycle on every platform.
export const showSettingsSaveDialog = (
  sender: WebContents,
  options: SaveDialogOptions
): Promise<SaveDialogReturnValue> => {
  const parentWindow = BrowserWindow.fromWebContents(sender)
  return parentWindow
    ? dialog.showSaveDialog(parentWindow, options)
    : dialog.showSaveDialog(options)
}
