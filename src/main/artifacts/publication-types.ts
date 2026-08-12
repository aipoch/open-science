import type { ArtifactFile, MovePendingRunArtifactsRequest } from '../../shared/artifacts'
import type { ArtifactDurability } from './durability'
import type {
  PendingFileTransactionOptions,
  PendingFileTransactionStorage
} from './pending-file-transaction'

type ArtifactMetadata = {
  mimeType?: string
  artifactId?: string
  versionId?: string
  versionNumber?: number
  artifactRunId?: string
  checksum?: string
  kind?: 'plan'
}

type PendingArtifactVersionRouting = Required<
  Pick<
    ArtifactMetadata,
    'artifactId' | 'versionId' | 'versionNumber' | 'artifactRunId' | 'checksum'
  >
> &
  Pick<ArtifactMetadata, 'mimeType'>

type PendingArtifactVersionRoute = PendingArtifactVersionRouting & {
  storageSessionId: string
  filename: string
  path: string
}

type ArtifactRunFinalizationMarker = {
  sessionId: string
  messageId?: string
  artifactVersionIds?: string[]
  provenanceContext?: NonNullable<MovePendingRunArtifactsRequest['provenanceContext']>
}

type ArtifactRunMarkerReadResult = {
  present: boolean
  marker?: ArtifactRunFinalizationMarker
}

type PendingArtifactRunPublication = {
  sourceSessionId: string
  runId: string
  marker?: ArtifactRunFinalizationMarker
}

type PrepareArtifactRunFinalizationRequest = {
  projectName: string
  sourceSessionId: string
  sessionId: string
  runId: string
  artifactVersionIds?: string[]
  provenanceContext: NonNullable<MovePendingRunArtifactsRequest['provenanceContext']>
}

type PendingArtifactVersionRoutingRequest = {
  projectName: string
  sessionId: string
  runId: string
  filename: string
  sourcePath: string
  routing: PendingArtifactVersionRouting
  allowRoutingReplacement?: boolean
  replaceUnroutedBytes?: boolean
}

type BindPendingArtifactVersionRouting = (
  routing: PendingArtifactVersionRouting,
  sourcePath: string
) => Promise<void>

type ArtifactPublicationStorage = PendingFileTransactionStorage & {
  durability: ArtifactDurability & { readMarkerFile?: (path: string) => Promise<string> }
  assertSafePathSegment: (segment: string) => string
  assertSafeFilename: (filename: string) => string
  normalizeArtifactVersionIds: (versionIds: readonly string[]) => string[]
  getProjectArtifactDir: (projectName: string) => string
  getMessageDir: (projectName: string, sessionId: string, messageId: string) => string
  readSubdirectoryNames: (directory: string) => Promise<string[]>
  readFileEntries: (directory: string) => Promise<Array<{ name: string }>>
  isPendingArtifactRunDirectory: (name: string) => boolean
  cleanupLegacyExecutionHandoffs: (directory: string) => Promise<void>
  readArtifactMetadata: (directory: string, filename: string) => Promise<ArtifactMetadata>
  toPendingRouting: (metadata: ArtifactMetadata) => PendingArtifactVersionRouting | undefined
  moveArtifactMetadata: (
    sourceDirectory: string,
    targetDirectory: string,
    filename: string
  ) => Promise<void>
  recoverMovedArtifactMetadata: (sourceDirectory: string, targetDirectory: string) => Promise<void>
  listMessageFiles: (request: {
    projectName: string
    sessionId: string
    messageId: string
  }) => Promise<ArtifactFile[]>
  sha256: (value: Buffer) => string
  isMissingFileError: (error: unknown) => boolean
}

export type {
  ArtifactMetadata,
  ArtifactPublicationStorage,
  ArtifactRunFinalizationMarker,
  ArtifactRunMarkerReadResult,
  BindPendingArtifactVersionRouting,
  PendingArtifactRunPublication,
  PendingArtifactVersionRoute,
  PendingArtifactVersionRouting,
  PendingArtifactVersionRoutingRequest,
  PendingFileTransactionOptions,
  PrepareArtifactRunFinalizationRequest
}
