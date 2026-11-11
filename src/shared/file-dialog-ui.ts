import type { Locale } from './locale'

export const FILE_DIALOG_UI_CHANNEL = 'file-dialog:action'

export type FileDialogLocation = {
  path: string
  parent: string
  folders: { name: string; path: string }[]
  truncated: boolean
}

export type FileDialogUiState = {
  mode: 'save' | 'directory'
  locale: Locale
  title?: string
  buttonLabel?: string
  filename: string
  filters: { name: string; extensions: string[] }[]
  shortcuts: { kind: 'downloads' | 'home' | 'desktop'; path: string }[]
  location: FileDialogLocation
}

export type FileDialogUiAction =
  | { type: 'init' }
  | { type: 'failed' }
  | { type: 'browse'; path: string }
  | { type: 'mkdir'; directory: string; name: string }
  | { type: 'select'; directory: string; filename: string; filterIndex: number }
  | { type: 'replace'; token: string }
  | { type: 'cancel' }

export type FileDialogUiError = 'folder' | 'filename' | 'extension' | 'destination' | 'changed'

export type FileDialogUiReply =
  | { type: 'init'; state: FileDialogUiState }
  | { type: 'browse'; location: FileDialogLocation }
  | { type: 'confirm'; filename: string; token: string }
  | { type: 'error'; code: FileDialogUiError }
  | { type: 'done' }

export type FileDialogUiBridge = {
  action: (action: FileDialogUiAction) => Promise<FileDialogUiReply>
}
