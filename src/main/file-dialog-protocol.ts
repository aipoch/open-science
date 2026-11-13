import type { FileDialogAppearance } from '../shared/file-dialog-ui'
import type { FileSaveTarget } from './file-save-target'
import type {
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue
} from 'electron'

export const FILE_DIALOG_DISPLAY_TIMEOUT_MS = 15_000

export type FileDialogRequest =
  { kind: 'open'; options: OpenDialogOptions } | { kind: 'save'; options: SaveDialogOptions }

export type FileDialogSaveResult = SaveDialogReturnValue & { target?: FileSaveTarget }
export type FileDialogResult = OpenDialogReturnValue | FileDialogSaveResult

export type FileDialogWindowRequest = FileDialogRequest & {
  operationId: string
  appearance: FileDialogAppearance
}

export const usesHtmlFileDialog = (request: FileDialogRequest): boolean =>
  (process.platform === 'win32' || process.platform === 'darwin') && request.kind === 'save'
