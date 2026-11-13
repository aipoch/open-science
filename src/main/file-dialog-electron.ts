import { randomUUID } from 'node:crypto'
import { createLogger, startDiagnosticOperation } from '@aipoch/diagnostics/node'
import {
  BrowserWindow,
  dialog,
  nativeTheme,
  type BaseWindow,
  type SaveDialogOptions
} from 'electron'
import { getFileDialogAppearance } from './file-dialog-appearance'
import { showInProcessFileDialog } from './file-dialog-save-window'
import { assertSelectedSavePath } from './file-dialog-filename'
import { usesHtmlSaveDialog, type FileDialogSaveResult } from './file-dialog-protocol'
import { snapshotFileTarget } from './user-file-publisher'

const runFileDialog = async <Result extends { canceled: boolean }>(
  parent: BaseWindow | undefined,
  show: (parent: BaseWindow | undefined) => Promise<Result>
): Promise<Result> => {
  const operation = startDiagnosticOperation(createLogger('native-file-dialog'), {
    operation: 'native-file-dialog',
    fields: { kind: 'save', platform: process.platform, parented: Boolean(parent) }
  })
  try {
    const result = await show(parent)
    if (result.canceled) operation.cancel()
    else operation.complete()
    return result
  } catch (error) {
    operation.fail(error)
    throw error
  }
}

export function showSaveDialog(
  parent: BaseWindow,
  options: SaveDialogOptions,
  signal?: AbortSignal
): Promise<FileDialogSaveResult>
export function showSaveDialog(options: SaveDialogOptions): Promise<FileDialogSaveResult>
export function showSaveDialog(
  parentOrOptions: BaseWindow | SaveDialogOptions,
  options?: SaveDialogOptions,
  signal?: AbortSignal
): Promise<FileDialogSaveResult> {
  const parent = options === undefined ? undefined : (parentOrOptions as BaseWindow)
  const dialogOptions = options ?? (parentOrOptions as SaveDialogOptions)
  if (usesHtmlSaveDialog()) {
    signal?.throwIfAborted()
    const dialogParent =
      parent ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    return showInProcessFileDialog(
      {
        kind: 'save',
        options: dialogOptions,
        operationId: randomUUID(),
        appearance: getFileDialogAppearance(dialogParent) ?? {
          theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
          followsSystem: true
        }
      },
      dialogParent,
      signal
    )
  }
  return runFileDialog(parent, async (dialogParent) => {
    const selected = await (dialogParent
      ? dialog.showSaveDialog(dialogParent, dialogOptions)
      : dialog.showSaveDialog(dialogOptions))
    if (!selected.canceled) {
      assertSelectedSavePath(dialogOptions, selected.filePath)
      return { ...selected, target: await snapshotFileTarget(selected.filePath) }
    }
    return selected
  })
}
