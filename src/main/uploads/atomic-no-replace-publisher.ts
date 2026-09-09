import { createRequire } from 'node:module'
import { isAbsolute, relative, sep } from 'node:path'

type NativePublisherBinding = typeof import('@aipoch/safe-file-publisher-native')

const require = createRequire(import.meta.url)
let binding: NativePublisherBinding | undefined

const loadBinding = (): NativePublisherBinding => {
  binding ??= require('@aipoch/safe-file-publisher-native') as NativePublisherBinding
  return binding
}

export const publishNoReplace = (
  rootPath: string,
  parentPath: string,
  sourceName: string,
  destinationName: string
): void => {
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
  loadBinding().publishNoReplace(rootPath, relativeParentPath, sourceName, destinationName)
}

export const removeAnchoredFile = (
  rootPath: string,
  relativeParentPath: string,
  filename: string,
  parent: { dev: bigint; ino: bigint }
): void => {
  loadBinding().removeAnchoredFile(rootPath, relativeParentPath, filename, parent.dev, parent.ino)
}
