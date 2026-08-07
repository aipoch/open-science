import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

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
