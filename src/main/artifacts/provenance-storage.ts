import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const storageKey = (...segments: string[]): string => segments.join('/')

const resolveStorageKey = (root: string, key: string): string => {
  if (!key || isAbsolute(key) || key.includes('\\')) {
    throw new Error('Invalid provenance storage key.')
  }
  const segments = key.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid provenance storage key.')
  }

  const candidate = resolve(root, ...segments)
  const relativePath = relative(resolve(root), candidate)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('Invalid provenance storage key.')
  }
  return candidate
}

const readOptionalFile = async (path: string): Promise<Buffer | undefined> =>
  readFile(path).catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return undefined
    }
    throw error
  })

export { readOptionalFile, resolveStorageKey, storageKey }

// The configured root may itself use a platform alias (/var -> /private/var). Below that owned
// root, reject links at every level so a Notebook directory cannot include unrelated local data.
export const assertRegularStoragePath = async (root: string, key: string): Promise<void> => {
  resolveStorageKey(root, key)
  const segments = key.split('/')
  for (let length = 1; length <= segments.length; length++) {
    const info = await lstat(join(root, ...segments.slice(0, length)))
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
      throw new Error('Session package source contains a link or special file.')
  }
}
