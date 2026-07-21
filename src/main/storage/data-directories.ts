// User-owned directories that follow the relocatable data root. Keep runtime separate: installed
// environments can contain hardcoded absolute paths and must be rebuilt after a storage move.
export const RELOCATABLE_DATA_DIRS = ['artifacts', 'notebooks', 'uploads', 'workspaces'] as const

export const DATA_ROOT_DIRS = [...RELOCATABLE_DATA_DIRS, 'runtime'] as const
