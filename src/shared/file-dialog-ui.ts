import type { Locale } from './locale'
import type { SaveFileFormat } from './file-save-name'

export const FILE_DIALOG_UI_CHANNEL = 'file-dialog:action'

export type FileDialogAppearance = {
  theme: 'light' | 'dark'
  followsSystem: boolean
  locale?: Locale
}

export type FileDialogLocation = {
  path: string
  parent: string
  folders: { name: string; path: string }[]
  truncated: boolean
}

export type FileDialogUiState = {
  mode: 'save' | 'directory'
  locale: Locale
  appearance: FileDialogAppearance
  title?: string
  buttonLabel?: string
  filename: string
  format: SaveFileFormat | null
  shortcuts: { kind: 'downloads' | 'home' | 'desktop'; path: string }[]
  location: FileDialogLocation
}

export type FileDialogUiAction =
  | { type: 'init' }
  | { type: 'ready'; height?: number }
  | { type: 'resize'; height: number }
  | { type: 'failed' }
  | { type: 'browse'; path: string }
  | { type: 'mkdir'; directory: string; name: string }
  | { type: 'select'; directory: string; filename: string }
  | { type: 'replace'; token: string }
  | { type: 'cancel' }

export type FileDialogUiError = 'folder' | 'filename' | 'extension' | 'destination' | 'changed'

export type FileDialogUiReply =
  | { type: 'init'; state: FileDialogUiState }
  | { type: 'browse'; location: FileDialogLocation }
  | { type: 'confirm'; filename: string; token: string }
  | { type: 'error'; code: FileDialogUiError; suggestions?: { keep: string; replace: string } }
  | { type: 'done' }

export type FileDialogUiBridge = {
  action: (action: FileDialogUiAction) => Promise<FileDialogUiReply>
}
