import { mkdir, open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import type {
  ArtifactFile,
  ArtifactSourceFileObservation,
  WritePendingArtifactFileRequest
} from '../../shared/artifacts'
import { validateArtifactContentType } from './content-type'
import {
  assertDiskReserve,
  copyOpenFileWithinBudget,
  inlineDecodedSize,
  writeInlineWithinBudget
} from '../bounded-file-io'
import type { FileDigest } from '../bounded-file-io'
import { LOCAL_RESOURCE_BUDGETS, assertWithinResourceBudget } from '../resource-budget'
import { availableBytes } from '../storage/usage'

type PendingFileTransactionOptions = {
  allowedImportRoots?: string[]
  relativeBaseDirs?: string[]
  maxFileBytes?: number
  maxInlineBytes?: number
  diskReserveBytes?: number
  signal?: AbortSignal
  reserveFile?: (fileBytes: number) => Promise<{ id: string; fileBytes: number }>
  releaseFileReservation?: (reservationId: string) => Promise<void>
}

type PendingFileBudgetReservation = {
  id: string
  fileBytes: number
}

type PendingFileTransactionStorage = {
  getPendingRunDir: (projectName: string, sessionId: string, runId: string) => string
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
    projectName: string
    sessionId: string
    filename: string
    filePath: string
    mimeType?: string
    metadata?: { kind?: 'plan' }
    runId?: string
  }) => Promise<ArtifactFile>
}

type BindPendingArtifactVersionRouting<Routing> = (
  routing: Routing,
  sourcePath: string
) => Promise<void>

const runPendingFileTransaction = async <Result, Routing>(options: {
  request: WritePendingArtifactFileRequest
  writeOptions: PendingFileTransactionOptions
  storage: PendingFileTransactionStorage
  publishRouting: BindPendingArtifactVersionRouting<Routing>
  operation: (
    artifact: ArtifactFile,
    sourceFileObservation: ArtifactSourceFileObservation | undefined,
    bindVersionRouting: BindPendingArtifactVersionRouting<Routing>,
    fileDigest: FileDigest,
    reservation: PendingFileBudgetReservation | undefined
  ) => Promise<Result>
}): Promise<Result> => {
  const { request, storage } = options
  const { projectName, sessionId, runId, filename } = request
  const directory = storage.getPendingRunDir(projectName, sessionId, runId)
  const filePath = join(directory, filename)
  const suffix = `${Date.now()}-${randomUUID()}`
  const temporaryPath = `${filePath}.${suffix}.tmp`
  const backupPath = `${filePath}.${suffix}.backup`
  const metadataPath = storage.getArtifactMetadataPath(directory, filename)
  const metadataBackupPath = `${metadataPath}.${suffix}.backup`
  let fileBackedUp = false
  let metadataBackedUp = false
  let preserveFileBackup = false
  let preserveMetadataBackup = false
  let replacementPublished = false
  let versionRoutingPublished = false
  let sourceFileObservation: ArtifactSourceFileObservation | undefined
  let fileDigest: FileDigest | undefined
  let reservation: PendingFileBudgetReservation | undefined

  await mkdir(directory, { recursive: true })
  try {
    if (request.source.kind === 'localPath') {
      const sourcePath = await storage.resolveAllowedImportFilePath(
        request.source.path,
        options.writeOptions.allowedImportRoots ?? [],
        options.writeOptions.relativeBaseDirs
      )
      const sourceHandle = await open(sourcePath, 'r')
      try {
        const beforeCopy = await sourceHandle.stat()
        if (!beforeCopy.isFile()) {
          throw new Error(`Artifact local source is not a regular file: "${sourcePath}".`)
        }
        const maxFileBytes =
          options.writeOptions.maxFileBytes ?? LOCAL_RESOURCE_BUDGETS.artifactFileBytes
        assertWithinResourceBudget('file', beforeCopy.size, maxFileBytes)
        reservation = await options.writeOptions.reserveFile?.(beforeCopy.size)
        if (reservation && reservation.fileBytes !== beforeCopy.size) {
          throw new Error('Artifact file reservation does not match the preflight source size.')
        }
        assertDiskReserve(
          await availableBytes(directory),
          beforeCopy.size,
          options.writeOptions.diskReserveBytes ?? LOCAL_RESOURCE_BUDGETS.diskReserveBytes
        )
        fileDigest = await copyOpenFileWithinBudget(
          sourceHandle,
          temporaryPath,
          reservation ? Math.min(maxFileBytes, reservation.fileBytes) : maxFileBytes,
          options.writeOptions.signal
        )
        const afterCopy = await sourceHandle.stat()
        if (afterCopy.size !== beforeCopy.size || afterCopy.mtimeMs !== beforeCopy.mtimeMs) {
          throw new Error(
            `Artifact local source changed while it was being imported: "${sourcePath}".`
          )
        }
        sourceFileObservation = {
          path: sourcePath,
          sizeBytes: afterCopy.size,
          mtimeMs: afterCopy.mtimeMs
        }
      } finally {
        await sourceHandle.close()
      }
    } else {
      const maxInlineBytes =
        options.writeOptions.maxInlineBytes ?? LOCAL_RESOURCE_BUDGETS.artifactInlineBytes
      const decodedBytes = inlineDecodedSize(request.source.content, request.source.encoding)
      assertWithinResourceBudget('file', decodedBytes, maxInlineBytes)
      reservation = await options.writeOptions.reserveFile?.(decodedBytes)
      assertDiskReserve(
        await availableBytes(directory),
        decodedBytes,
        options.writeOptions.diskReserveBytes ?? LOCAL_RESOURCE_BUDGETS.diskReserveBytes
      )
      fileDigest = await writeInlineWithinBudget(
        temporaryPath,
        request.source.content,
        request.source.encoding,
        maxInlineBytes,
        options.writeOptions.signal
      )
    }

    validateArtifactContentType({
      filename,
      declaredContentType: request.mimeType,
      sample: await storage.readFilePrefix(temporaryPath)
    })
    fileBackedUp = await storage.renameIfPresent(filePath, backupPath)
    metadataBackedUp = await storage.renameIfPresent(metadataPath, metadataBackupPath)
    await rename(temporaryPath, filePath)
    replacementPublished = true
    await storage.writeArtifactMetadata(directory, filename, {
      mimeType: request.mimeType,
      kind: request.kind
    })

    const artifact = await storage.createArtifactFile({
      projectName,
      sessionId,
      runId,
      filename,
      filePath,
      mimeType: request.mimeType,
      metadata: { kind: request.kind }
    })
    const bindVersionRouting: BindPendingArtifactVersionRouting<Routing> = async (
      routing,
      sourcePath
    ) => {
      await options.publishRouting(routing, sourcePath)
      versionRoutingPublished = true
    }
    if (!fileDigest) throw new Error('Artifact pending write completed without a file digest.')
    const result = await options.operation(
      artifact,
      sourceFileObservation,
      bindVersionRouting,
      fileDigest,
      reservation
    )
    await Promise.all([
      rm(backupPath, { force: true }).catch(() => undefined),
      rm(metadataBackupPath, { force: true }).catch(() => undefined)
    ])
    return result
  } catch (error) {
    const recoveryErrors: unknown[] = []
    if (reservation && options.writeOptions.releaseFileReservation) {
      try {
        await options.writeOptions.releaseFileReservation(reservation.id)
      } catch (releaseError) {
        recoveryErrors.push(releaseError)
      }
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    if (replacementPublished && !versionRoutingPublished) {
      await Promise.all([
        rm(filePath, { force: true }).catch(() => undefined),
        rm(metadataPath, { force: true }).catch(() => undefined)
      ])
    }
    if (fileBackedUp && !versionRoutingPublished) {
      try {
        await rename(backupPath, filePath)
      } catch (recoveryError) {
        preserveFileBackup = true
        recoveryErrors.push(recoveryError)
      }
    }
    if (metadataBackedUp && !versionRoutingPublished) {
      try {
        await mkdir(dirname(metadataPath), { recursive: true })
        await rename(metadataBackupPath, metadataPath)
      } catch (recoveryError) {
        preserveMetadataBackup = true
        recoveryErrors.push(recoveryError)
      }
    }
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        `Artifact pending-file rollback or reservation release failed: ${recoveryErrors
          .map((recoveryError) =>
            recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          )
          .join('; ')}`
      )
    }
    throw error
  } finally {
    await Promise.all([
      rm(temporaryPath, { force: true }).catch(() => undefined),
      preserveFileBackup
        ? Promise.resolve()
        : rm(backupPath, { force: true }).catch(() => undefined),
      preserveMetadataBackup
        ? Promise.resolve()
        : rm(metadataBackupPath, { force: true }).catch(() => undefined)
    ])
  }
}

export { runPendingFileTransaction }
export type {
  PendingFileBudgetReservation,
  PendingFileTransactionOptions,
  PendingFileTransactionStorage
}
