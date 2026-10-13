import type { ManagedFileIdentity, ManagedFileSource } from '../../shared/managed-file-versions'

export type ArtifactProducerInputScope = {
  appSessionId: string
  artifactRunId: string
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  runtimeSegmentId: string
  promptMessageId: string
  // Host-owned liveness check; never deserialize this capability from an RPC request.
  assertActive: () => void
}

export type ManagedFileVersionRecord = {
  id: string
  fileId: string
  versionNumber: number
  state: string
  managedVisibleAt?: Date | null
  originKind: string
  basedOnVersionId: string | null
  storageTag: string | null
  storedFilename: string | null
  writeOperationId: string | null
  contentStorageKey: string
  filename: string
  originalFilename: string | null
  contentType: string | null
  sizeBytes: bigint
  checksum: string
  createdAt: Date
}

export type ManagedLogicalFile = {
  source: ManagedFileSource
  id: string
  projectId: string
  sessionId: string
  displayName: string
  currentVersionId: string | null
}

export type ResolvedManagedFileVersion = {
  logicalFile: ManagedLogicalFile
  version: ManagedFileVersionRecord
}

export type ManagedFileReadLease = ResolvedManagedFileVersion & {
  path: string
  size: number
  versionToken: number
  snapshot: ManagedFileLeaseSnapshot
  read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ) => Promise<{ bytesRead: number }>
  readRange: (begin: number, end: number) => Promise<Uint8Array>
  copyTo: (destinationPath: string, options?: { exclusive?: boolean }) => Promise<void>
  assertCanCopyTo?: (destinationPath: string) => Promise<void>
  verifyUnchanged: () => Promise<void>
  close: () => Promise<void>
}

export type ManagedFileLeaseSnapshot = {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
}

export type ManagedFileVersionReadPort = {
  openLatest(request: ManagedFileIdentity): Promise<ManagedFileReadLease>
  openVersion(request: ManagedFileIdentity, versionId: string): Promise<ManagedFileReadLease>
  openProducerVersion(
    projectId: string,
    versionId: string,
    scope: ArtifactProducerInputScope
  ): Promise<ManagedFileReadLease | undefined>
}
