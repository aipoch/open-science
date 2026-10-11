import type { DiscoveryRecord, DiscoveryReference, LiteratureSourceInput } from './contracts.js'

export interface MetadataCatalog<Item extends DiscoveryReference = DiscoveryReference> {
  get(id: string): Promise<Item | undefined>
  getMetadataCommitReceipt(operationId: string): Promise<{
    operationId: string
    itemId: string
    expectedMetadataRevision: number
    committedMetadataRevision: number
  } | null>
  applyMetadata(input: {
    operationId?: string
    itemId: string
    expectedMetadataRevision: number
    item: DiscoveryRecord
    source: LiteratureSourceInput
    sources?: readonly LiteratureSourceInput[]
  }): Promise<Item>
}

export interface FullTextCatalog<Item extends DiscoveryReference = DiscoveryReference> {
  get(id: string): Promise<Item | undefined>
  attachContent(input: {
    itemId: string
    expectedMetadataRevision: number
    contentBlobId: string
    filename: string
    contentType: string
    sizeBytes: number
    checksum: string
    pageCount: number
    provenance: {
      provider: string
      source: string
      sourceUrl: string
      acquiredAt: number
      version?: 'published' | 'accepted' | 'submitted'
      license?: string
    }
  }): Promise<{ attachmentId: string; versionId: string }>
}

// Publication and attachment commit remain in one caller-owned transaction/lifetime.
export interface FullTextContent {
  withPublishedContent<T>(
    request: { sourcePath: string; contentType: string },
    commit: (content: { id: string; sizeBytes: bigint | number; checksum: string }) => Promise<T>
  ): Promise<T>
}

// The adapter owns atomic replacement/fsync and crash-temp recovery. The package owns
// version decoding, epochs, row checkpoints and which data may be committed or retired.
export interface CheckpointStorage {
  read<T>(
    path: string,
    decode: (contents: string) => T,
    maxBytes: number
  ): Promise<{ status: 'found'; value: T } | { status: 'missing' }>
  write(path: string, contents: string): Promise<void>
  recoverDirectory(
    path: string,
    decode: (path: string, contents: string) => unknown,
    maxBytes: number
  ): Promise<void>
  recoveryBarrier(message: string): Error
}

export interface WriteAdmission {
  acquireWriter(): () => void
  isPending(): boolean
  withWrite<T>(operation: () => Promise<T>): Promise<T>
}
