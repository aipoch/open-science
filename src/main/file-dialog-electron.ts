import { createLogger, startDiagnosticOperation } from '@aipoch/diagnostics/node'
import {
  dialog,
  type BaseWindow,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions
} from 'electron'
import { showFileDialogInHelper } from './file-dialog-process'
import { assertSelectedSavePath } from './file-dialog-filename'
import { usesHtmlFileDialog, type FileDialogSaveResult } from './file-dialog-protocol'
import { snapshotFileTarget } from './file-save-target'

const runFileDialog = async <Result extends { canceled: boolean }>(
  kind: 'open' | 'save',
  parent: BaseWindow | undefined,
  show: (parent: BaseWindow | undefined) => Promise<Result>
): Promise<Result> => {
  const operation = startDiagnosticOperation(createLogger('native-file-dialog'), {
    operation: 'native-file-dialog',
    fields: { kind, platform: process.platform, isolated: false, parented: Boolean(parent) }
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

export function showOpenDialog(
  parent: BaseWindow,
  options: OpenDialogOptions,
  signal?: AbortSignal
): Promise<OpenDialogReturnValue>
export function showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>
export function showOpenDialog(
  parentOrOptions: BaseWindow | OpenDialogOptions,
  options?: OpenDialogOptions,
  signal?: AbortSignal
): Promise<OpenDialogReturnValue> {
  const parent = options === undefined ? undefined : (parentOrOptions as BaseWindow)
  const dialogOptions = options ?? (parentOrOptions as OpenDialogOptions)
  if (process.platform === 'win32' || usesHtmlFileDialog({ kind: 'open', options: dialogOptions }))
    return showFileDialogInHelper(
      { kind: 'open', options: dialogOptions },
      parent,
      signal
    ) as Promise<OpenDialogReturnValue>
  return runFileDialog('open', parent, (dialogParent) =>
    dialogParent
      ? dialog.showOpenDialog(dialogParent, dialogOptions)
      : dialog.showOpenDialog(dialogOptions)
  )
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
  if (process.platform === 'win32' || usesHtmlFileDialog({ kind: 'save', options: dialogOptions }))
    return showFileDialogInHelper(
      { kind: 'save', options: dialogOptions },
      parent,
      signal
    ) as Promise<FileDialogSaveResult>
  return runFileDialog('save', parent, async (dialogParent) => {
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
