import { createRequire } from 'node:module'
import { isAbsolute, relative, sep } from 'node:path'

type NativePublisherBinding = {
  supportsAnchoredWrites: boolean
  publishNoReplace: (
    rootPath: string,
    relativeParentPath: string,
    sourceName: string,
    destinationName: string
  ) => void
  writeAndPublishNoReplace: (
    rootPath: string,
    relativeParentPath: string,
    temporaryName: string,
    destinationName: string,
    bytes: Buffer
  ) => void
  readFile: (rootPath: string, relativeParentPath: string, name: string) => Buffer
  readFileBounded: (
    rootPath: string,
    relativeParentPath: string,
    name: string,
    maxBytes: number
  ) => Buffer
  publishVerifiedNoReplace: (
    rootPath: string,
    relativeParentPath: string,
    temporaryName: string,
    destinationName: string,
    expectedBytes: Buffer
  ) => void
  verifyFile: (
    rootPath: string,
    relativeParentPath: string,
    name: string,
    expectedSizeBytes: number,
    expectedSha256: string
  ) => boolean
  statFile: (rootPath: string, relativeParentPath: string, name: string) => { sizeBytes: number }
  removeFile: (rootPath: string, relativeParentPath: string, name: string) => boolean
  listDirectory: (
    rootPath: string,
    relativeParentPath: string
  ) => Array<{ name: string; isFile: boolean; mtimeMs: number }>
}

const require = createRequire(import.meta.url)
let binding: NativePublisherBinding | undefined

const loadBinding = (): NativePublisherBinding => {
  if (!binding) {
    try {
      binding = assertNativePublisherBinding(require('@aipoch/safe-file-publisher-native'))
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'MODULE_NOT_FOUND'
      ) {
        throw error
      }
      // Worktrees share the main checkout's dependencies, where local file packages are not linked
      // back into this checkout. Production installs always resolve the package name above.
      binding = assertNativePublisherBinding(
        require('../../../packages/safe-file-publisher-native')
      )
    }
  }
  return binding
}

type NativeBindingLoader = () => unknown

const isNativePublisherBinding = (candidate: unknown): candidate is NativePublisherBinding => {
  if (!candidate || typeof candidate !== 'object') return false
  const value = candidate as Record<string, unknown>
  return (
    typeof value.supportsAnchoredWrites === 'boolean' &&
    [
      'publishNoReplace',
      'writeAndPublishNoReplace',
      'readFile',
      'readFileBounded',
      'publishVerifiedNoReplace',
      'verifyFile',
      'statFile',
      'removeFile',
      'listDirectory'
    ].every((name) => typeof value[name] === 'function')
  )
}

const assertNativePublisherBinding = (candidate: unknown): NativePublisherBinding => {
  if (!isNativePublisherBinding(candidate)) {
    const error = new Error('Native managed-file publisher binding is incomplete.')
    Object.assign(error, { code: 'ENOTSUP' })
    throw error
  }
  return candidate
}

export const managedFileVersionNativeCapability = (
  loader: NativeBindingLoader = loadBinding
):
  | { available: true; readFallbackAvailable: false }
  | {
      available: false
      reason: 'NATIVE_WRITE_REQUIRED'
      readFallbackAvailable: boolean
    } => {
  try {
    return assertNativePublisherBinding(loader()).supportsAnchoredWrites
      ? { available: true, readFallbackAvailable: false }
      : {
          available: false,
          reason: 'NATIVE_WRITE_REQUIRED',
          readFallbackAvailable: true
        }
  } catch {
    return {
      available: false,
      reason: 'NATIVE_WRITE_REQUIRED',
      readFallbackAvailable: false
    }
  }
}

const relativeParent = (rootPath: string, parentPath: string): string => {
  const relativeParentPath = relative(rootPath, parentPath)
  if (
    isAbsolute(relativeParentPath) ||
    relativeParentPath === '..' ||
    relativeParentPath.startsWith(`..${sep}`)
  ) {
    const error = new Error('The publication parent is outside the storage root.')
    Object.assign(error, { code: 'EINVAL' })
    throw error
  }
  return relativeParentPath
}

export const publishNoReplace = (
  rootPath: string,
  parentPath: string,
  sourceName: string,
  destinationName: string
): void => {
  loadBinding().publishNoReplace(
    rootPath,
    relativeParent(rootPath, parentPath),
    sourceName,
    destinationName
  )
}

export const writeAndPublishNoReplace = (
  rootPath: string,
  parentPath: string,
  temporaryName: string,
  destinationName: string,
  bytes: Buffer
): void => {
  loadBinding().writeAndPublishNoReplace(
    rootPath,
    relativeParent(rootPath, parentPath),
    temporaryName,
    destinationName,
    bytes
  )
}

export const readAnchoredFile = (rootPath: string, parentPath: string, name: string): Buffer =>
  loadBinding().readFile(rootPath, relativeParent(rootPath, parentPath), name)

export const readAnchoredFileBounded = (
  rootPath: string,
  parentPath: string,
  name: string,
  maxBytes: number
): Buffer =>
  loadBinding().readFileBounded(rootPath, relativeParent(rootPath, parentPath), name, maxBytes)

export const publishVerifiedAnchoredFileNoReplace = (
  rootPath: string,
  parentPath: string,
  temporaryName: string,
  destinationName: string,
  expectedBytes: Buffer
): void =>
  loadBinding().publishVerifiedNoReplace(
    rootPath,
    relativeParent(rootPath, parentPath),
    temporaryName,
    destinationName,
    expectedBytes
  )

export const verifyAnchoredFile = (
  rootPath: string,
  parentPath: string,
  name: string,
  expectedSizeBytes: number,
  expectedSha256: string
): boolean =>
  loadBinding().verifyFile(
    rootPath,
    relativeParent(rootPath, parentPath),
    name,
    expectedSizeBytes,
    expectedSha256
  )

export const statAnchoredFile = (
  rootPath: string,
  parentPath: string,
  name: string
): { sizeBytes: number } =>
  loadBinding().statFile(rootPath, relativeParent(rootPath, parentPath), name)

export const removeAnchoredFile = (rootPath: string, parentPath: string, name: string): boolean =>
  loadBinding().removeFile(rootPath, relativeParent(rootPath, parentPath), name)

export const listAnchoredDirectory = (
  rootPath: string,
  parentPath: string
): Array<{ name: string; isFile: boolean; mtimeMs: number }> =>
  loadBinding().listDirectory(rootPath, relativeParent(rootPath, parentPath))
