import { PdfTranslationCheckpoints as Checkpoints } from '@aipoch/pdf-translation/storage'
import type {
  TranslationDatabase,
  TranslationCheckpointIdentity
} from '@aipoch/pdf-translation/storage'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { PdfDocumentSource } from '../../../shared/pdf-document-source'
import { findVerifiedPdfDocument, registerVerifiedPdfContent } from '../../pdf-documents/identity'
import { createLogger } from '@aipoch/diagnostics/node'
import { withDataRootWrite, runDataRootStartupRecovery } from '../../storage/migration-state'
import { translationTransaction } from './checkpoint-repository'
import {
  toTranslationSourceId,
  fromTranslationSourceId,
  toPackageCheckpoint,
  fromPackageCheckpoint,
  toPackageBegin,
  pdfTranslationSourceKey,
  pdfTranslationDocumentSourceSchema,
  type PdfTranslationCheckpoint,
  type PdfTranslationCheckpointRequest,
  type PdfTranslationBeginRequest,
  type PdfTranslationSaveSnapshotRequest,
  type PdfTranslationRecordLayoutRequest,
  type PdfTranslationSelectEditionRequest
} from '../../../shared/pdf-translation'
import type {
  PdfTranslationModel,
  PdfTranslationBlockFailure
} from '@aipoch/pdf-translation/contracts'
type CheckpointIdentity = Pick<
  PdfTranslationCheckpoint,
  'attachmentVersionId' | 'documentSource' | 'checksum'
>
const hostIdentity = (identity: TranslationCheckpointIdentity): CheckpointIdentity => {
  const source = fromTranslationSourceId(identity.sourceId)
  return {
    checksum: identity.checksum,
    ...(typeof source === 'string' ? { attachmentVersionId: source } : { documentSource: source })
  }
}
const log = createLogger('pdf-translation-checkpoint')
async function requireSource(
  tx: Prisma.TransactionClient,
  identity: CheckpointIdentity
): Promise<{ sizeBytes: bigint }> {
  const source = identity.documentSource
  if (!source) {
    const version = await tx.literatureAttachmentVersion.findFirst({
      where: {
        id: identity.attachmentVersionId,
        checksum: identity.checksum,
        attachment: { item: { deletedAt: null, mergedIntoItemId: null } }
      }
    })
    if (!version) throw new Error('Translation source is unavailable.')
    return { sizeBytes: version.sizeBytes }
  }
  const project = await tx.project.findFirst({ where: { id: source.projectId, deletedAt: null } })
  const version =
    source.kind === 'upload-version'
      ? await tx.uploadVersion.findFirst({
          where: {
            id: source.versionId,
            uploadFileId: source.sourceFileId,
            checksum: identity.checksum,
            state: 'ready',
            uploadFile: { projectId: source.projectId }
          }
        })
      : await tx.artifactVersion.findFirst({
          where: {
            id: source.versionId,
            artifactId: source.sourceFileId,
            checksum: identity.checksum,
            state: 'finalized',
            artifact: { projectId: source.projectId }
          }
        })
  if (!project || !version) throw new Error('Translation source is unavailable.')
  return { sizeBytes: version.sizeBytes }
}
async function requireDocument(
  tx: Prisma.TransactionClient,
  identity: CheckpointIdentity,
  source: { sizeBytes: bigint }
): Promise<string> {
  const content = { checksum: identity.checksum, sizeBytes: source.sizeBytes }
  const document = await findVerifiedPdfDocument(tx, {
    kind: identity.documentSource?.kind ?? 'literature-attachment-version',
    versionId: identity.documentSource?.versionId ?? identity.attachmentVersionId!,
    checksum: identity.checksum
  })
  // resolveIdentity has already verified the managed bytes, including older unregistered PDFs.
  return (document ?? (await registerVerifiedPdfContent(tx, content))).id
}
export class PdfTranslationCheckpoints {
  private readonly store: Checkpoints
  constructor(options: {
    getClient: () => Promise<PrismaClient>
    authority: {
      resolveVersion(
        versionId: string
      ): Promise<{ attachmentId: string; checksum: string } | undefined>
    }
    resolveDocumentSource?: (source: PdfDocumentSource) => Promise<PdfDocumentSource | undefined>
  }) {
    const clients = new WeakMap<PrismaClient, TranslationDatabase>()
    this.store = new Checkpoints({
      async getClient() {
        const client = await options.getClient()
        let adapter = clients.get(client)
        if (!adapter) {
          adapter = {
            canPersist: async (identity) => {
              const source = hostIdentity(identity)
              return (
                !source.attachmentVersionId ||
                Boolean(
                  await client.literatureAttachmentVersion.findUnique({
                    where: { id: source.attachmentVersionId }
                  })
                )
              )
            },
            transaction: (operation) =>
              client.$transaction((tx) =>
                operation(
                  translationTransaction(tx, {
                    requireSource: (identity) => requireSource(tx, hostIdentity(identity)),
                    requireDocument: (identity, source) =>
                      requireDocument(tx, hostIdentity(identity), source)
                  })
                )
              )
          }
          clients.set(client, adapter)
        }
        return adapter
      },
      async resolveSource(sourceId) {
        const source = fromTranslationSourceId(sourceId)
        if (typeof source === 'string' || source.kind === 'literature-attachment-version') {
          const versionId = typeof source === 'string' ? source : source.versionId
          const version = await options.authority.resolveVersion(versionId)
          if (
            !version ||
            (typeof source !== 'string' &&
              (version.attachmentId !== source.sourceFileId ||
                version.checksum !== source.checksum))
          )
            throw new Error('Translation source is unavailable.')
          return { sourceId: toTranslationSourceId(versionId), checksum: version.checksum }
        }
        const supplied = pdfTranslationDocumentSourceSchema.parse(source)
        const resolved = await options.resolveDocumentSource?.(supplied)
        if (!resolved || pdfTranslationSourceKey(supplied) !== pdfTranslationSourceKey(resolved))
          throw new Error('Translation source is unavailable.')
        return { sourceId: toTranslationSourceId(resolved), checksum: resolved.checksum }
      },
      diagnostics: {
        debug: (m, f) => log.debug(m, f),
        info: (m, f) => log.info(m, f),
        warn: (m, f) => log.warn(m, f),
        errorFields: () => ({})
      },
      writes: { write: withDataRootWrite, recover: runDataRootStartupRecovery }
    })
  }

  contentKey(source: PdfTranslationCheckpointRequest): Promise<string> {
    return this.store.contentKey(toTranslationSourceId(source))
  }
  async read(
    source: PdfTranslationCheckpointRequest,
    key?: string
  ): Promise<PdfTranslationCheckpoint | null> {
    const value = await this.store.read(toTranslationSourceId(source), key)
    return value ? fromPackageCheckpoint(value) : null
  }
  list(source: PdfTranslationCheckpointRequest): ReturnType<Checkpoints['list']> {
    return this.store.list(toTranslationSourceId(source))
  }
  async select(
    request: PdfTranslationSelectEditionRequest,
    signal?: AbortSignal
  ): Promise<PdfTranslationCheckpoint> {
    return fromPackageCheckpoint(
      await this.store.select({ ...request, source: toTranslationSourceId(request.source) }, signal)
    )
  }
  delete(request: PdfTranslationSelectEditionRequest, signal?: AbortSignal): Promise<void> {
    return this.store.delete({ ...request, source: toTranslationSourceId(request.source) }, signal)
  }
  async open(
    input: PdfTranslationBeginRequest,
    targetKey: string,
    model: PdfTranslationModel
  ): Promise<PdfTranslationCheckpoint | undefined> {
    const value = await this.store.open(toPackageBegin(input), targetKey, model)
    return value ? fromPackageCheckpoint(value) : undefined
  }
  async append(
    checkpoint: PdfTranslationCheckpoint,
    index: number,
    text: string | undefined,
    signal: AbortSignal,
    replaceExisting = false,
    diagnostic?: PdfTranslationBlockFailure
  ): Promise<PdfTranslationCheckpoint> {
    return fromPackageCheckpoint(
      await this.store.append(
        toPackageCheckpoint(checkpoint),
        index,
        text,
        signal,
        replaceExisting,
        diagnostic
      )
    )
  }
  saveSnapshot(request: PdfTranslationSaveSnapshotRequest, signal: AbortSignal): Promise<void> {
    return this.store.saveSnapshot(
      { ...request, source: toTranslationSourceId(request.source) },
      signal
    )
  }
  recordLayout(request: PdfTranslationRecordLayoutRequest, signal: AbortSignal): Promise<void> {
    return this.store.recordLayout(
      { ...request, source: toTranslationSourceId(request.source) },
      signal
    )
  }
}
