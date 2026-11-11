import { createLogger, startDiagnosticOperation } from '@aipoch/diagnostics/node'
import {
  dialog,
  type BaseWindow,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue
} from 'electron'
import { showFileDialogInHelper } from './file-dialog-process'

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
  if (process.platform === 'win32')
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
): Promise<SaveDialogReturnValue>
export function showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>
export function showSaveDialog(
  parentOrOptions: BaseWindow | SaveDialogOptions,
  options?: SaveDialogOptions,
  signal?: AbortSignal
): Promise<SaveDialogReturnValue> {
  const parent = options === undefined ? undefined : (parentOrOptions as BaseWindow)
  const dialogOptions = options ?? (parentOrOptions as SaveDialogOptions)
  if (process.platform === 'win32')
    return showFileDialogInHelper(
      { kind: 'save', options: dialogOptions },
      parent,
      signal
    ) as Promise<SaveDialogReturnValue>
  return runFileDialog('save', parent, (dialogParent) =>
    dialogParent
      ? dialog.showSaveDialog(dialogParent, dialogOptions)
      : dialog.showSaveDialog(dialogOptions)
  )
}
