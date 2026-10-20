import type { PackageLiterature } from './literature-contract'

export type PackageLiteratureVersion = {
  id: string
  attachmentId: string
  itemId: string
  versionNumber: number
  filename: string
  contentType: string
  sizeBytes: bigint
  checksum: string
  storageKey: string
  createdAt: Date
}

/** Read-only snapshots; implementations verify live content identity and return a stable order. */
export type PackageLiteratureSource = {
  readVersions(versionIds: readonly string[]): Promise<PackageLiteratureVersion[]>
  readItem(itemId: string): Promise<PackageLiterature['items'][number] | undefined>
}
