import { createLogger, startDiagnosticOperation } from '@aipoch/diagnostics/node'
import {
  dialog,
  type BaseWindow,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue
} from 'electron'

const runFileDialog = async <Result extends { canceled: boolean }>(
  kind: 'open' | 'save',
  parent: BaseWindow | undefined,
  show: (parent: BaseWindow | undefined) => Promise<Result>
): Promise<Result> => {
  // Windows async file dialogs run on a dedicated STA thread. Omit the cross-thread owner to
  // mitigate reported third-party IME crashes; callers must still validate their document.
  const dialogParent = process.platform === 'win32' ? undefined : parent
  const operation = startDiagnosticOperation(createLogger('native-file-dialog'), {
    operation: 'native-file-dialog',
    fields: { kind, platform: process.platform, parented: Boolean(dialogParent) }
  })
  try {
    const result = await show(dialogParent)
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
  options: OpenDialogOptions
): Promise<OpenDialogReturnValue>
export function showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>
export function showOpenDialog(
  parentOrOptions: BaseWindow | OpenDialogOptions,
  options?: OpenDialogOptions
): Promise<OpenDialogReturnValue> {
  const parent = options === undefined ? undefined : (parentOrOptions as BaseWindow)
  const dialogOptions = options ?? (parentOrOptions as OpenDialogOptions)
  return runFileDialog('open', parent, (dialogParent) =>
    dialogParent
      ? dialog.showOpenDialog(dialogParent, dialogOptions)
      : dialog.showOpenDialog(dialogOptions)
  )
}

export function showSaveDialog(
  parent: BaseWindow,
  options: SaveDialogOptions
): Promise<SaveDialogReturnValue>
export function showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>
export function showSaveDialog(
  parentOrOptions: BaseWindow | SaveDialogOptions,
  options?: SaveDialogOptions
): Promise<SaveDialogReturnValue> {
  const parent = options === undefined ? undefined : (parentOrOptions as BaseWindow)
  const dialogOptions = options ?? (parentOrOptions as SaveDialogOptions)
  return runFileDialog('save', parent, (dialogParent) =>
    dialogParent
      ? dialog.showSaveDialog(dialogParent, dialogOptions)
      : dialog.showSaveDialog(dialogOptions)
  )
}
