export const supportsAnchoredWrites: boolean

export function publishNoReplace(
  rootPath: string,
  relativeParentPath: string,
  sourceName: string,
  destinationName: string
): void

export function writeAndPublishNoReplace(
  rootPath: string,
  relativeParentPath: string,
  temporaryName: string,
  destinationName: string,
  bytes: Buffer
): void

export function readFile(rootPath: string, relativeParentPath: string, name: string): Buffer

export function readFileBounded(
  rootPath: string,
  relativeParentPath: string,
  name: string,
  maxBytes: number
): Buffer

export function publishVerifiedNoReplace(
  rootPath: string,
  relativeParentPath: string,
  temporaryName: string,
  destinationName: string,
  expectedBytes: Buffer
): void

export function verifyFile(
  rootPath: string,
  relativeParentPath: string,
  name: string,
  expectedSizeBytes: number,
  expectedSha256: string
): boolean

export function statFile(
  rootPath: string,
  relativeParentPath: string,
  name: string
): { sizeBytes: number }

export function removeFile(rootPath: string, relativeParentPath: string, name: string): boolean

export type AnchoredDirectoryEntry = {
  name: string
  isFile: boolean
  mtimeMs: number
}

export function listDirectory(
  rootPath: string,
  relativeParentPath: string
): AnchoredDirectoryEntry[]

export type StoragePathCapabilities = {
  isRemote: boolean
  supportsHardLinks: boolean
}

export function inspectPath(path: string): StoragePathCapabilities
