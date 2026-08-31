// Durable directories that follow the relocatable data root. Keep runtime separate: installed
// environments can contain hardcoded absolute paths and must be rebuilt after a storage move.
export const RELOCATABLE_DATA_DIRS = [
  'artifacts',
  'compute',
  'delegation',
  'notebooks',
  'execution-file-evidence',
  'uploads',
  'workspaces'
] as const

// Read/move/delete only. New evidence is written exclusively to execution-file-evidence/.
export const LEGACY_RELOCATABLE_DATA_DIRS = ['notebook-file-evidence'] as const
export const MIGRATABLE_DATA_DIRS = [
  ...RELOCATABLE_DATA_DIRS,
  ...LEGACY_RELOCATABLE_DATA_DIRS
] as const

export const DATA_ROOT_DIRS = [...RELOCATABLE_DATA_DIRS, 'runtime'] as const
