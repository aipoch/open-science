import { isAbsolute } from 'node:path'
import { isLocale } from '../shared/locale'
import type { FileDialogAppearance } from '../shared/file-dialog-ui'
import { fileSaveTargetSchema, type FileSaveTarget } from './file-save-target'
import type {
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue
} from 'electron'

export const FILE_DIALOG_HELPER_ARG = '--open-science-file-dialog-helper'
export const FILE_DIALOG_PROFILE_ENV = 'OPEN_SCIENCE_FILE_DIALOG_PROFILE'
export const FILE_DIALOG_DISPLAY_TIMEOUT_MS = 15_000

export type FileDialogRequest =
  { kind: 'open'; options: OpenDialogOptions } | { kind: 'save'; options: SaveDialogOptions }

export type FileDialogSaveResult = SaveDialogReturnValue & { target?: FileSaveTarget }
export type FileDialogResult = OpenDialogReturnValue | FileDialogSaveResult

export const usesHtmlFileDialog = (request: FileDialogRequest): boolean =>
  (process.platform === 'win32' || process.platform === 'darwin') &&
  (request.kind === 'save' ||
    (request.options.properties?.includes('openDirectory') === true &&
      !request.options.properties.includes('openFile') &&
      !request.options.properties.includes('multiSelections')))

export type FileDialogHelperRequest = FileDialogRequest & {
  type: 'show'
  presentation: 'native' | 'html'
  operationId: string
  crashDumpsPath: string
  appVersion: string
  appearance: FileDialogAppearance
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const isFileDialogHelperRequest = (value: unknown): value is FileDialogHelperRequest =>
  record(value) &&
  value.type === 'show' &&
  (value.presentation === 'native' || value.presentation === 'html') &&
  (value.kind === 'open' || value.kind === 'save') &&
  record(value.options) &&
  record(value.appearance) &&
  (value.appearance.theme === 'light' || value.appearance.theme === 'dark') &&
  typeof value.appearance.followsSystem === 'boolean' &&
  (value.appearance.locale === undefined || isLocale(value.appearance.locale)) &&
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
    if (kind === 'save' && selectedPath(raw.filePath)) {
      const target = raw.target === undefined ? undefined : fileSaveTargetSchema.parse(raw.target)
      if (target && target.path !== raw.filePath) throw new Error('Save target path mismatch.')
      return { canceled: false, filePath: raw.filePath, ...(target ? { target } : {}) }
    }
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
