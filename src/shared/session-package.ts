import { z } from 'zod'
import { PROJECT_NAME_MAX_LENGTH } from './projects'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const checksum = z.string().regex(/^[a-f0-9]{64}$/)
export const PACKAGE_MAX_FILE_BYTES = 32 * 1024 ** 3
export const PACKAGE_MAX_BYTES = 256 * 1024 ** 3
export const PACKAGE_DEFAULT_IO_BYTES_PER_SECOND = 16 * 1024 ** 2
const transferRateSchema = z
  .number()
  .int()
  .min(1024 ** 2)
  .max(64 * 1024 ** 2)

export const sessionPackageImportRequestSchema = z
  .object({
    projectId: identity.optional(),
    projectName: z.string().trim().min(1).max(PROJECT_NAME_MAX_LENGTH).optional()
  })
  .strict()
  .refine((target) => !(target.projectId && target.projectName), 'Choose one import destination.')
export type SessionPackageImportRequest = z.infer<typeof sessionPackageImportRequestSchema>

// Package limits use binary units; keep both native and renderer size labels explicit.
export const formatPackageBytes = (value: number): string => {
  const unit = value >= 1024 ** 3 ? 'GiB' : value >= 1024 ** 2 ? 'MiB' : value >= 1024 ? 'KiB' : 'B'
  const divisor = { GiB: 1024 ** 3, MiB: 1024 ** 2, KiB: 1024, B: 1 }[unit]
  return `${(value / divisor).toFixed(unit === 'B' ? 0 : 1)} ${unit}`
}

export const packageExcludedFileSchema = z
  .object({
    storageKey: z.string().min(1).max(2048),
    filename: z.string().min(1).max(1000),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
export type PackageExcludedFile = z.infer<typeof packageExcludedFileSchema>
export type PackageSelectableFile = PackageExcludedFile & {
  groupId: string
  source: 'artifact' | 'upload' | 'reproducibility'
  versionNumber: number
  requiredForEvidence?: boolean
  dependentFiles: string[]
}

export type PackageSelectionSummary = {
  retainedFiles: PackageExcludedFile[]
  metadataBytes: number
}

export type PackageProgress = {
  phase:
    | 'preparing'
    | 'selecting'
    | 'copying'
    | 'validating'
    | 'compressing'
    | 'saving'
    | 'importing'
    | 'choosing-location'
    | 'confirming'
    | 'cleaning'
  completedBytes?: number
  totalBytes?: number
  completedFiles?: number
  totalFiles?: number
  currentFile?: string
}

export type PackageOperationSnapshot = {
  id: string
  kind: 'export' | 'import'
  session?: SessionPackageRequest
  importTarget?: SessionPackageImportRequest
  presentationRevision?: number
  importRequestId?: string
  importFilename?: string
  importPreview?: SessionPackagePreview
  pendingImports?: { id: string; filename: string }[]
  importQueueFull?: boolean
  state: 'running' | 'awaiting-selection' | 'cancelling' | 'succeeded' | 'cancelled' | 'failed'
  progress: PackageProgress
  files?: PackageSelectableFile[]
  summary?: PackageSelectionSummary
  result?: { filePath?: string; imported?: SessionPackageRequest }
  error?: string
  cleanupPending?: boolean
  transferBytesPerSecond?: number
  ioBytesPerSecond?: number
}

export const packageOperationRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshot') }).strict(),
  z.object({ action: z.literal('cancel'), operationId: identity }).strict(),
  z
    .object({
      action: z.literal('select-project'),
      operationId: identity,
      target: sessionPackageImportRequestSchema.refine(
        (target) => Boolean(target.projectId || target.projectName),
        'Choose an import destination.'
      )
    })
    .strict(),
  z.object({ action: z.literal('confirm-import'), operationId: identity }).strict(),
  z
    .object({ action: z.literal('discard-import'), operationId: identity, requestId: identity })
    .strict(),
  z.object({ action: z.literal('next-import'), operationId: identity }).strict(),
  z.object({ action: z.literal('dismiss-queue-warning'), operationId: identity }).strict(),
  z.object({ action: z.literal('retry-import'), operationId: identity }).strict(),
  z.object({ action: z.literal('reveal'), operationId: identity }).strict(),
  z.object({ action: z.literal('retry-cleanup'), operationId: identity }).strict(),
  z
    .object({
      action: z.literal('set-speed'),
      operationId: identity,
      bytesPerSecond: transferRateSchema
    })
    .strict(),
  z
    .object({
      action: z.literal('select'),
      operationId: identity,
      excludedStorageKeys: z.array(z.string().max(2048)).max(10000)
    })
    .strict()
])
export type PackageOperationRequest = z.infer<typeof packageOperationRequestSchema>

export const packageOriginSchema = z
  .object({
    importId: identity,
    sourceProjectId: identity,
    sourceSessionId: identity,
    importedAt: z.number().int().nonnegative(),
    manifestChecksum: checksum,
    excludedFiles: z.array(packageExcludedFileSchema).max(10000).optional()
  })
  .strict()
export type SessionPackageOrigin = z.infer<typeof packageOriginSchema>

export const sessionPackageRequestSchema = z
  .object({ projectId: identity, sessionId: identity })
  .strict()
export type SessionPackageRequest = z.infer<typeof sessionPackageRequestSchema>

export const packageInventoryEntrySchema = z
  .object({
    path: z.string().regex(/^(session\.json|records\.json|README\.md|objects\/[a-f0-9]{64})$/),
    sizeBytes: z.number().int().nonnegative().max(PACKAGE_MAX_FILE_BYTES),
    checksum,
    storageKey: z.string().max(2048).optional(),
    kind: z.enum(['session', 'records', 'file', 'notebook', 'readme'])
  })
  .strict()

export const sessionPackageManifestSchema = z
  .object({
    format: z.literal('open-science-session'),
    schemaVersion: z.literal(1),
    createdAt: z.number().int().nonnegative(),
    source: z
      .object({
        projectId: identity,
        sessionId: identity,
        projectName: z.string().min(1).max(200),
        title: z.string().max(1000)
      })
      .strict(),
    inventory: z.array(packageInventoryEntrySchema).max(10000),
    excludedFiles: z.array(packageExcludedFileSchema).max(10000).default([]),
    omissions: z
      .array(
        z
          .object({
            kind: z.enum(['missing', 'excluded', 'external']),
            description: z.string().max(2000)
          })
          .strict()
      )
      .max(10000)
  })
  .strict()
export type SessionPackageManifest = z.infer<typeof sessionPackageManifestSchema>
export type SessionPackageInventoryEntry = z.infer<typeof packageInventoryEntrySchema>

export const sessionPackagePreviewSchema = z
  .object({
    title: z.string(),
    projectName: z.string(),
    branchCount: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    omissions: sessionPackageManifestSchema.shape.omissions
  })
  .strict()
export type SessionPackagePreview = z.infer<typeof sessionPackagePreviewSchema>

export const sessionPackageReceiptSchema = packageOriginSchema
  .extend({
    schemaVersion: z.literal(1),
    projectId: identity,
    sessionId: identity,
    identities: z.record(identity, identity),
    files: z
      .array(
        z
          .object({
            sourceStorageKey: z.string().max(2048),
            localStorageKey: z.string().max(2048),
            sourceChecksum: checksum,
            localChecksum: checksum
          })
          .strict()
      )
      .max(10000)
  })
  .strict()
export type SessionPackageReceipt = z.infer<typeof sessionPackageReceiptSchema>

const exportResultSchema = z
  .object({ saved: z.boolean(), filePath: z.string().optional() })
  .strict()
export type SessionPackageExportResult = z.infer<typeof exportResultSchema>
export type SessionPackageImportResult = SessionPackageRequest | null
const packageOperationSnapshotSchema: z.ZodType<PackageOperationSnapshot> = z
  .object({
    id: identity,
    kind: z.enum(['export', 'import']),
    session: sessionPackageRequestSchema.optional(),
    importTarget: sessionPackageImportRequestSchema.optional(),
    presentationRevision: z.number().int().nonnegative().optional(),
    importRequestId: identity.optional(),
    importFilename: z.string().optional(),
    importPreview: sessionPackagePreviewSchema.optional(),
    pendingImports: z
      .array(z.object({ id: identity, filename: z.string() }).strict())
      .max(16)
      .optional(),
    importQueueFull: z.boolean().optional(),
    state: z.enum([
      'running',
      'awaiting-selection',
      'cancelling',
      'succeeded',
      'cancelled',
      'failed'
    ]),
    progress: z
      .object({
        phase: z.enum([
          'preparing',
          'selecting',
          'copying',
          'validating',
          'compressing',
          'saving',
          'importing',
          'choosing-location',
          'confirming',
          'cleaning'
        ]),
        completedBytes: z.number().nonnegative().optional(),
        totalBytes: z.number().nonnegative().optional(),
        completedFiles: z.number().int().nonnegative().optional(),
        totalFiles: z.number().int().nonnegative().optional(),
        currentFile: z.string().optional()
      })
      .strict(),
    files: z
      .array(
        packageExcludedFileSchema.extend({
          groupId: z.string(),
          source: z.enum(['artifact', 'upload', 'reproducibility']),
          versionNumber: z.number().int().positive(),
          requiredForEvidence: z.boolean().optional(),
          dependentFiles: z.array(z.string())
        })
      )
      .max(10000)
      .optional(),
    summary: z
      .object({
        retainedFiles: z.array(packageExcludedFileSchema).max(10000),
        metadataBytes: z.number().nonnegative()
      })
      .strict()
      .optional(),
    result: z
      .object({ filePath: z.string().optional(), imported: sessionPackageRequestSchema.optional() })
      .strict()
      .optional(),
    error: z.string().optional(),
    cleanupPending: z.boolean().optional(),
    transferBytesPerSecond: transferRateSchema.optional(),
    ioBytesPerSecond: z.number().nonnegative().optional()
  })
  .strict()
export const sessionPackageCommandContracts = {
  operation: defineApplicationCommandContract(
    validationCodec(z.tuple([packageOperationRequestSchema])),
    validationCodec(packageOperationSnapshotSchema.nullable())
  ),
  export: defineApplicationCommandContract(
    validationCodec(z.tuple([sessionPackageRequestSchema])),
    validationCodec(exportResultSchema)
  ),
  import: defineApplicationCommandContract(
    validationCodec(z.tuple([sessionPackageImportRequestSchema.optional()])),
    validationCodec(sessionPackageRequestSchema.nullable())
  )
}
