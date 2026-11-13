import type { FileDialogAppearance } from '../shared/file-dialog-ui'
import type { FileSaveTarget } from './file-save-target'
import type { SaveDialogOptions, SaveDialogReturnValue } from 'electron'

export const FILE_DIALOG_DISPLAY_TIMEOUT_MS = 15_000

export type FileDialogRequest = { kind: 'save'; options: SaveDialogOptions }

export type FileDialogSaveResult = SaveDialogReturnValue & { target?: FileSaveTarget }

export type FileDialogWindowRequest = FileDialogRequest & {
  operationId: string
  appearance: FileDialogAppearance
}

export const usesHtmlSaveDialog = (): boolean =>
  process.platform === 'win32' || process.platform === 'darwin'
