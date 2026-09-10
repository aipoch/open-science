export function publishNoReplace(
  rootPath: string,
  relativeParentPath: string,
  sourceName: string,
  destinationName: string
): void

export type StoragePathCapabilities = {
  isRemote: boolean
  supportsHardLinks: boolean
}

export function inspectPath(path: string): StoragePathCapabilities

export function removeAnchoredFile(
  rootPath: string,
  relativeParentPath: string,
  filename: string,
  parentDev: bigint,
  parentIno: bigint,
  fileDev: bigint,
  fileIno: bigint,
  fileSize: bigint,
  fileMtimeNs: bigint,
  quarantineName: string
): void

export function recoverAnchoredRemoval(
  rootPath: string,
  relativeParentPath: string,
  quarantineName: string,
  parentDev: bigint,
  parentIno: bigint
): void
