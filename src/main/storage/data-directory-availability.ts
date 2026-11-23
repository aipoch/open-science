import { stat } from 'node:fs/promises'

export class DataDirectoryUnavailableError extends Error {
  constructor(path: string) {
    super(
      `The saved data location is missing or is not a directory: ${path}. Reconnect it before restarting.`
    )
    this.name = 'DataDirectoryUnavailableError'
  }
}

export async function isDataDirectoryUnavailable(path: string): Promise<boolean> {
  try {
    return !(await stat(path)).isDirectory()
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENODEV') return true
    throw error
  }
}
