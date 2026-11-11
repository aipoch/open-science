import { isAbsolute } from 'node:path'
import type {
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue
} from 'electron'

export const FILE_DIALOG_HELPER_ARG = '--open-science-file-dialog-helper'
export const FILE_DIALOG_PROFILE_ENV = 'OPEN_SCIENCE_FILE_DIALOG_PROFILE'

export type FileDialogRequest =
  { kind: 'open'; options: OpenDialogOptions } | { kind: 'save'; options: SaveDialogOptions }

export type FileDialogResult = OpenDialogReturnValue | SaveDialogReturnValue

export type FileDialogHelperRequest = FileDialogRequest & {
  type: 'show'
  operationId: string
  crashDumpsPath: string
  appVersion: string
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const isFileDialogHelperRequest = (value: unknown): value is FileDialogHelperRequest =>
  record(value) &&
  value.type === 'show' &&
  (value.kind === 'open' || value.kind === 'save') &&
  record(value.options) &&
  typeof value.operationId === 'string' &&
  typeof value.appVersion === 'string' &&
  typeof value.crashDumpsPath === 'string' &&
  isAbsolute(value.crashDumpsPath)

const selectedPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 32_768 &&
  !value.includes('\0') &&
  isAbsolute(value)

// Only a valid selection from a normally exiting helper may reach the file publisher.
export function parseFileDialogResult(
  kind: FileDialogRequest['kind'],
  raw: unknown
): FileDialogResult {
  if (record(raw) && typeof raw.canceled === 'boolean') {
    if (raw.canceled)
      return kind === 'open' ? { canceled: true, filePaths: [] } : { canceled: true, filePath: '' }
    if (kind === 'save' && selectedPath(raw.filePath))
      return { canceled: false, filePath: raw.filePath }
    if (
      kind === 'open' &&
      Array.isArray(raw.filePaths) &&
      raw.filePaths.length > 0 &&
      raw.filePaths.length <= 10_000 &&
      raw.filePaths.every(selectedPath)
    )
      return { canceled: false, filePaths: raw.filePaths }
  }
  throw new Error('Native file dialog helper returned an invalid selection.')
}
