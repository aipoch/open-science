import type { ArtifactFile } from '../../shared/artifacts'

type PendingFileTransactionOptions = {
  allowedImportRoots?: string[]
  relativeBaseDirs?: string[]
  maxFileBytes?: number
  maxInlineBytes?: number
  diskReserveBytes?: number
  preserveRecoveryState?: () => Promise<boolean>
  signal?: AbortSignal
  reserveFile?: (fileBytes: number) => Promise<{ id: string; fileBytes: number }>
  releaseFileReservation?: (reservationId: string) => Promise<void>
}

type PendingFileTransactionStorage = {
  getPendingRunDir: (projectId: string, sessionId: string, runId: string) => string
  getArtifactMetadataPath: (directory: string, filename: string) => string
  resolveAllowedImportFilePath: (
    path: string,
    allowedImportRoots: string[],
    relativeBaseDirs?: string[]
  ) => Promise<string>
  readFilePrefix: (path: string) => Promise<Buffer>
  renameIfPresent: (sourcePath: string, targetPath: string) => Promise<boolean>
  writeArtifactMetadata: (
    directory: string,
    filename: string,
    metadata: { mimeType?: string; kind?: 'plan' }
  ) => Promise<void>
  createArtifactFile: (request: {
    projectId: string
    sessionId: string
    filename: string
    filePath: string
    mimeType?: string
    metadata?: { kind?: 'plan' }
    runId?: string
  }) => Promise<ArtifactFile>
}

export type { PendingFileTransactionOptions, PendingFileTransactionStorage }
