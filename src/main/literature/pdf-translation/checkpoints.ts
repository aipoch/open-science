import { PdfTranslationCheckpoints as Checkpoints } from '@aipoch/pdf-translation/storage'
import type {
  TranslationDatabase,
  TranslationTransaction,
  TranslationCheckpointIdentity as CheckpointIdentity
} from '@aipoch/pdf-translation/storage'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { PdfDocumentSource } from '@aipoch/pdf-document-contract'
import { findVerifiedPdfDocument, registerVerifiedPdfContent } from '../../pdf-documents/identity'
import { createLogger } from '@aipoch/diagnostics/node'
import { withDataRootWrite, runDataRootStartupRecovery } from '../../storage/migration-state'
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
const transaction = (tx: Prisma.TransactionClient): TranslationTransaction => ({
  $queryRaw: <T>(
    query: Parameters<TranslationTransaction['$executeRaw']>[0],
    ...values: unknown[]
  ) => tx.$queryRaw<T>(query, ...values),
  $executeRaw: (query, ...values) => tx.$executeRaw(query, ...values),
  requireSource: (identity) => requireSource(tx, identity),
  requireDocument: (identity, source) => requireDocument(tx, identity, source)
})
export class PdfTranslationCheckpoints extends Checkpoints {
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
    super({
      async getClient() {
        const client = await options.getClient()
        let adapter = clients.get(client)
        if (!adapter) {
          adapter = {
            hasAttachment: async (versionId) =>
              Boolean(
                await client.literatureAttachmentVersion.findUnique({ where: { id: versionId } })
              ),
            $transaction: (operation) => client.$transaction((tx) => operation(transaction(tx)))
          }
          clients.set(client, adapter)
        }
        return adapter
      },
      get authority() {
        return options.authority
      },
      get resolveDocumentSource() {
        return options.resolveDocumentSource
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
}
