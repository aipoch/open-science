import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'

import { validateLocalPath } from '../../shared/local-fs'

export type DirectoryValidationReason =
  'not-absolute' | 'not-found' | 'not-accessible' | 'not-directory' | 'not-writable'

export class DirectoryValidationError extends Error {
  constructor(
    readonly reason: DirectoryValidationReason,
    readonly path: string
  ) {
    super(`Directory validation failed (${reason}): ${path}`)
    this.name = 'DirectoryValidationError'
  }
}

// Shared by explicit Task working directories and Project folders. Do not trim here: spaces are
// legal filename characters; transports that accept typed input can normalize that input first.
export async function canonicalizeDirectory(path: string): Promise<string> {
  if (validateLocalPath(path, process.platform) !== undefined)
    throw new DirectoryValidationError('not-absolute', path)
  let canonical: string
  let metadata: Awaited<ReturnType<typeof stat>>
  try {
    canonical = await realpath(path)
    metadata = await stat(canonical)
  } catch (error) {
    const missing =
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
    throw new DirectoryValidationError(missing ? 'not-found' : 'not-accessible', path)
  }
  if (!metadata.isDirectory()) throw new DirectoryValidationError('not-directory', path)
  try {
    await access(canonical, constants.R_OK | constants.W_OK)
  } catch {
    throw new DirectoryValidationError('not-writable', path)
  }
  return canonical
}
