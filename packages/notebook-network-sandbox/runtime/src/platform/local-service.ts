import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, normalize } from 'node:path'

/** Host-issued authority for a private Unix socket, never a workload-supplied URL or TCP port. */
export type NotebookLocalService = Readonly<{
  executionId: string
  socketPath: string
}>

export const validateLocalService = (
  value: NotebookLocalService,
  platform: NodeJS.Platform,
  target: 'native' | 'wsl2' = 'native'
): NotebookLocalService => {
  if (platform !== 'darwin' || target !== 'native') {
    throw new Error('Notebook local services are supported only by the native macOS sandbox.')
  }
  const captured = validateLocalServiceLocation(value)
  try {
    lstatSync(captured.socketPath)
    throw new Error('Notebook local service socket path is already occupied.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return captured
}

/** Shared by launch admission and the host's generation lease; does not confer network access. */
export const validateLocalServiceLocation = (value: NotebookLocalService): NotebookLocalService => {
  if (
    !value ||
    typeof value.executionId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value.executionId) ||
    Object.keys(value).some((key) => !['executionId', 'socketPath'].includes(key))
  ) {
    throw new Error('Invalid Notebook local service identity.')
  }
  const socketPath = value.socketPath
  const directoryPrefix = `os-service-${value.executionId}-`
  if (
    typeof socketPath !== 'string' ||
    !isAbsolute(socketPath) ||
    normalize(socketPath) !== socketPath ||
    socketPath.includes('\0') ||
    Buffer.byteLength(socketPath) > 103 ||
    basename(socketPath) !== 'service.sock' ||
    !basename(dirname(socketPath)).startsWith(directoryPrefix) ||
    !/^[A-Za-z0-9]{6}$/.test(basename(dirname(socketPath)).slice(directoryPrefix.length))
  ) {
    throw new Error('Notebook local service requires an exact run-owned Unix socket path.')
  }
  const parent = dirname(socketPath)
  const metadata = lstatSync(parent)
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync.native(parent) !== parent ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new Error('Notebook local service directory must be private and owned by this user.')
  }
  return Object.freeze({ executionId: value.executionId, socketPath })
}
