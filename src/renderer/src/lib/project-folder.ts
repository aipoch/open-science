import type { ProjectFolderProblem } from './project-folder-error'

export type ProjectFolderWarning = 'cloud-synced' | 'removable' | 'network'
export type ProjectFolderValidation =
  | { ok: true; path: string; warnings?: ProjectFolderWarning[] }
  | ({ ok: false; path?: string } & ProjectFolderProblem)

export type ProjectFolderForm = {
  mode: 'create' | 'edit'
  storage: 'managed' | 'folder'
  path?: string
  validation?: ProjectFolderValidation
  isBusy: boolean
  canSelect: boolean
  onStorageChange: (storage: 'managed' | 'folder') => void
  onChoose: () => void
  onReveal: () => void
  outputLayout?: 'legacy' | 'session-v1'
  enableSessionOutputs?: boolean
  onEnableSessionOutputsChange?: (enabled: boolean) => void
}
