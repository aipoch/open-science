import { open, type FileHandle } from 'node:fs/promises'

type SyncHandle = Pick<FileHandle, 'sync' | 'close'>
type OpenSyncHandle = (path: string, flags: 'r' | 'r+') => Promise<SyncHandle>

export type FileDurability = {
  syncFile: (path: string) => Promise<void>
  syncDirectory: (path: string) => Promise<void>
}

type FileDurabilityOptions = {
  openHandle?: OpenSyncHandle
  platform?: NodeJS.Platform
}

const defaultOpenHandle: OpenSyncHandle = (path, flags) => open(path, flags)

const syncOpenPath = async (
  openHandle: OpenSyncHandle,
  path: string,
  flags: 'r' | 'r+'
): Promise<void> => {
  const handle = await openHandle(path, flags)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export const createFileDurability = (options: FileDurabilityOptions = {}): FileDurability => {
  const openHandle = options.openHandle ?? defaultOpenHandle
  const platform = options.platform ?? process.platform

  return {
    // Windows requires a write-capable handle for FlushFileBuffers. Opening an ordinary file with
    // `r` makes FileHandle.sync() fail with EPERM even when the file itself is writable.
    syncFile: (path) => syncOpenPath(openHandle, path, 'r+'),
    syncDirectory: async (path) => {
      try {
        await syncOpenPath(openHandle, path, 'r')
      } catch (error) {
        // Node cannot open or flush directory handles on Windows. File barriers still protect the
        // payload there; POSIX platforms additionally make directory publication durable.
        if (
          platform === 'win32' &&
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes(String(error.code))
        ) {
          return
        }
        throw error
      }
    }
  }
}

export const defaultFileDurability = createFileDurability()
