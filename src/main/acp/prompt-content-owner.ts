import type { ContentBlock } from '@agentclientprotocol/sdk'
import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import {
  MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE,
  MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE,
  sanitizeAcpMessageImage,
  type AcpMessageImage,
  type AcpReplayMessageImage
} from '../../shared/acp'
import type { FileReference } from '../../shared/artifacts'
import { estimateHistoryTokens, truncateTextToEstimatedTokens } from '../../shared/history-preamble'
import {
  resolvePdfPreparationScope,
  type PdfPreparationScope
} from '../../shared/pdf-preparation-scope'
import type { PdfReadingPosition } from '../../shared/session-persistence'
import {
  createUploadVersionReference,
  imageAttachmentMimeType,
  PENDING_UPLOAD_SESSION_ID,
  type UploadedAttachment
} from '../../shared/uploads'
import {
  readBoundedManagedFilePreview,
  readBoundedManagedFilePreviewLease
} from '../managed-file-preview'
import { createLogger, errorLogFields } from '../logger'
import {
  buildImageContentData,
  canInlineImageInSession,
  consumeInlineImageBudget,
  extractPdfText,
  ImageContentError,
  MAX_AUTO_EXTRACT_PDF_BYTES,
  MAX_AUTO_PROCESS_IMAGE_BYTES,
  MAX_SESSION_INLINE_IMAGE_BYTES,
  type InlineImageBudget
} from '../uploads/attachment-media'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import type { UploadRepository } from '../uploads/repository'
import {
  isImportableSkillArchive,
  isImportableSkillArchivePath
} from '../skills/skill-archive-sniffer'
import {
  ATTACHMENT_PREVIEW_BYTES,
  MAX_EMBEDDED_TEXT_UPLOAD_BYTES,
  buildDatasetAttachmentNotice,
  buildDeferredMediaNotice,
  buildLocalFileAttachmentNotice,
  buildOversizedAttachmentNotice,
  isDatasetAttachment,
  isTabularAttachment,
  isTextLikeAttachment,
  mimeEssence
} from './attachment-content'
import type { FileReferenceResolver, TrustedFileReferenceLease } from './file-reference-resolver'
import { TurnResourceSnapshotStore } from './turn-resource-snapshot-store'
import type { VisionEvidenceSource } from './vision-evidence-repository'

type CodexSkillInput = {
  name: string
  path: string
}

type ResourceSnapshotScope = Readonly<{
  appSessionId: string
  projectId: string
}>

type AcpPromptContentOwnerOptions = {
  uploadRepository?: UploadRepository
  managedFileVersions?: Pick<ManagedFileVersionService, 'openLatest'>
  fileReferenceResolver: FileReferenceResolver
  inlineImageBudgetBytes?: number
  createResourceSnapshotStore?: (scope: ResourceSnapshotScope) => TurnResourceSnapshotStore
}

type PrepareAcpPromptContentInput = {
  appSessionId: string
  projectId: string
  connectionGeneration?: number
  text: string
  historyImages: ReadonlyArray<AcpReplayMessageImage>
  currentImages?: ReadonlyArray<AcpMessageImage>
  historyUploads: ReadonlyArray<UploadedAttachment>
  currentUploads: ReadonlyArray<UploadedAttachment>
  references: ReadonlyArray<FileReference>
  codexSkillInputs: ReadonlyArray<CodexSkillInput>
  skillImportEnabled: boolean
  imageCompatibilityRelay?: boolean
  fileTextBudget?: number
  skillImportTurnToken?: string
  onSkillImportAttachmentEligible?: (attachmentUri: string) => void
}

type AcpPromptTurnInputs = {
  uploads: UploadedAttachment[]
  references: FileReference[]
}

type PreparedAcpPromptContent = {
  content: string | ContentBlock[]
  historyImageCount: number
  imageSources?: ReadonlyArray<VisionEvidenceSource | undefined>
  turnInputs?: AcpPromptTurnInputs
  close: () => void
}

type ResolvedPromptFile = {
  absolutePath: string
  uri: string
  skillImportUri?: string
  name: string
  mimeType?: string
  size: number
  allowSkillImportReference: boolean
  trustedLease?: TrustedFileReferenceLease
}

type PromptFileTextBudget = {
  remaining: number
  perFileLimit: number
}

type PdfExtractionResult = {
  block: ContentBlock
  status: 'extracted' | 'no-selectable-text' | 'failed'
  pageCount?: number
  extractedChars: number
  extractorTruncated: boolean
}

type LinkedPdfContext = Readonly<{
  documentId: string
  documentCount: number
  active: boolean
}>

type PromptFileSource = 'current-upload' | 'history-upload' | 'file-reference'
const log = createLogger('literature-reading-context')

const PDF_COLLECTION_INTENT =
  /这些|全部|所有|三篇|两篇|逐篇|对比|比较|共同|差异|\b(?:these|all|both|three|compare|comparison)\b|\bacross (?:the )?(?:papers|documents)\b/i

const buildPdfReadingContext = (name: string, position: PdfReadingPosition): string =>
  [
    '<current_pdf_reading_context>',
    JSON.stringify({ name, ...position, capturedAtSend: true }),
    '</current_pdf_reading_context>',
    'The pageNumber above is the page visible in the user’s PDF reader when this message was sent. Answer current-page questions directly from it; do not use tools to rediscover the page.'
  ].join('\n')

const sanitizePdfReadingPosition = (value: unknown): PdfReadingPosition | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { pageNumber, pageCount } = value as Record<string, unknown>
  return typeof pageNumber === 'number' &&
    typeof pageCount === 'number' &&
    Number.isSafeInteger(pageNumber) &&
    Number.isSafeInteger(pageCount) &&
    pageNumber >= 1 &&
    pageCount >= pageNumber
    ? { pageNumber, pageCount }
    : undefined
}

const isImageBlock = (block: ContentBlock): boolean =>
  block.type === 'image' ||
  (block.type === 'resource_link' && block.mimeType?.startsWith('image/') === true)

const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? (error as { message?: unknown }).message : error

    return typeof raw === 'string' ? raw : String(raw)
  } catch {
    return 'unknown error'
  }
}

// Owns provider-ready prompt content and the media budget associated with each provider context.
// Session/turn admission, authorization leases, Notebook registration, and provider dispatch remain
// with the runtime; every piece of content resolved here is supplied explicitly by the caller.
class AcpPromptContentOwner {
  private readonly sessionInlineImageBytes = new Map<number, Map<string, number>>()
  private readonly activePreparedResources = new Set<() => void>()
  private readonly inlineImageBudgetBytes: number

  constructor(private readonly options: AcpPromptContentOwnerOptions) {
    this.inlineImageBudgetBytes = options.inlineImageBudgetBytes ?? MAX_SESSION_INLINE_IMAGE_BYTES
  }

  async prepare(input: PrepareAcpPromptContentInput): Promise<PreparedAcpPromptContent> {
    const snapshots =
      this.options.createResourceSnapshotStore?.({
        appSessionId: input.appSessionId,
        projectId: input.projectId
      }) ?? new TurnResourceSnapshotStore()
    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      this.activePreparedResources.delete(close)
      try {
        snapshots.close()
      } catch (error) {
        try {
          log.error('turn resource snapshot cleanup failed', errorLogFields(error))
        } catch {
          // Snapshot cleanup cannot replace the provider outcome.
        }
      }
    }
    this.activePreparedResources.add(close)
    try {
      return await this.prepareOwned(input, snapshots, close)
    } catch (error) {
      close()
      throw error
    }
  }

  private async prepareOwned(
    input: PrepareAcpPromptContentInput,
    snapshots: TurnResourceSnapshotStore,
    close: () => void
  ): Promise<PreparedAcpPromptContent> {
    const hasUploads = input.historyUploads.length > 0 || input.currentUploads.length > 0
    if ((input.currentImages?.length ?? 0) > MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE) {
      throw new Error(
        `A prompt can include at most ${MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE} current images.`
      )
    }
    let currentImageBytes = 0
    const currentImages = (input.currentImages ?? []).map((candidate, index) => {
      const image = sanitizeAcpMessageImage(candidate)
      if (!image) throw new Error(`Invalid current image at index ${index}.`)
      currentImageBytes += image.byteLength
      if (currentImageBytes > MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE) {
        throw new Error(
          `Current images exceed the ${MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE}-byte per-message budget.`
        )
      }
      return image
    })
    let promptUploads: UploadedAttachment[] = []
    const resolvedReferences: FileReference[] = []
    let historyImageCount = 0
    const imageSources: Array<VisionEvidenceSource | undefined> = []

    let content: string | ContentBlock[]
    if (
      !hasUploads &&
      input.references.length === 0 &&
      input.historyImages.length === 0 &&
      currentImages.length === 0
    ) {
      content = input.text
    } else {
      const contentBlocks: ContentBlock[] = input.text.trim()
        ? [{ type: 'text', text: input.text }]
        : []
      let imageBudget: InlineImageBudget = { imageCount: 0, base64Bytes: 0 }
      const totalFileTextBudget = Math.max(1, Math.floor(input.fileTextBudget ?? 12_000))
      const fileTextBudget: PromptFileTextBudget = {
        remaining: totalFileTextBudget,
        perFileLimit: Math.max(1, Math.floor(totalFileTextBudget / 2))
      }
      const appendBlock = (
        block: ContentBlock,
        overflowFallback?: ContentBlock,
        source?: VisionEvidenceSource
      ): boolean => {
        if (block.type === 'image' && !input.imageCompatibilityRelay) {
          try {
            imageBudget = consumeInlineImageBudget(imageBudget, {
              data: block.data,
              mimeType: block.mimeType
            })
          } catch (error) {
            if (
              error instanceof ImageContentError &&
              error.code === 'IMAGE_TOTAL_BUDGET_EXCEEDED'
            ) {
              if (overflowFallback) {
                contentBlocks.push(overflowFallback)
                if (isImageBlock(overflowFallback)) imageSources.push(source)
              }
              return false
            }
            throw error
          }
        }
        contentBlocks.push(block)
        if (isImageBlock(block)) imageSources.push(source)
        return true
      }

      for (const image of input.historyImages) {
        const source =
          image.sourceMessageId && image.sourceImageId
            ? {
                kind: 'message-image' as const,
                messageId: image.sourceMessageId,
                imageId: image.sourceImageId
              }
            : undefined
        if (
          appendBlock(
            { type: 'image', data: image.data, mimeType: image.mimeType },
            undefined,
            source
          )
        ) {
          historyImageCount += 1
        }
      }
      if (input.historyImages.length > 0) {
        this.setSessionInlineImageBytes(input, imageBudget.base64Bytes)
      }

      for (const image of currentImages) {
        appendBlock({ type: 'image', data: image.data, mimeType: image.mimeType })
      }

      if (hasUploads) {
        if (!this.options.uploadRepository) throw new Error('Upload storage is not configured.')

        // Historical Versions retain their immutable source ownership. Branch reconciles its staged
        // history first; other callers may still supply a genuine pending capability for this target.
        const stagedHistoryUploads = input.historyUploads.filter(
          (upload) => !upload.versionId && upload.sessionId === PENDING_UPLOAD_SESSION_ID
        )
        const stagedCurrentUploads = input.currentUploads.filter((upload) => !upload.versionId)
        const uploadsToFinalize = [...stagedHistoryUploads, ...stagedCurrentUploads]
        const finalizedUploads =
          uploadsToFinalize.length > 0
            ? await this.options.uploadRepository.finalizePendingSessionUploads(
                input.appSessionId,
                uploadsToFinalize,
                input.projectId
              )
            : []
        const finalizedById = new Map(finalizedUploads.map((upload) => [upload.id, upload]))
        promptUploads = [
          ...input.historyUploads.map((upload) => finalizedById.get(upload.id) ?? upload),
          ...input.currentUploads.map((upload) => finalizedById.get(upload.id) ?? upload)
        ]

        // Preserve the existing order: history uploads, current uploads, then explicit references.
        for (let index = 0; index < promptUploads.length; index += 1) {
          const resolved = await this.createAttachmentContentBlocks(
            input,
            promptUploads[index],
            index < input.historyUploads.length,
            fileTextBudget,
            snapshots
          )
          promptUploads[index] = resolved.attachment
          for (const block of resolved.blocks) {
            const appended = appendBlock(
              block,
              this.imageOverflowResourceLink(
                block,
                resolved.attachment.originalName,
                resolved.attachment.size
              ),
              resolved.attachment.versionId
                ? { kind: 'upload-version', uploadVersionId: resolved.attachment.versionId }
                : undefined
            )
            if (index < input.historyUploads.length && isImageBlock(block) && appended) {
              historyImageCount += 1
            }
          }
        }
      }

      for (const reference of input.references) {
        const resolved = await this.createReferencedArtifactContentBlocks(
          input,
          reference,
          fileTextBudget,
          snapshots
        )
        resolvedReferences.push(resolved.reference)
        for (const block of resolved.blocks) {
          appendBlock(block, this.imageOverflowResourceLink(block, reference.name))
        }
      }

      content = contentBlocks
    }

    const preparedContent = this.attachCodexSkillInputs(content, input.codexSkillInputs)
    const turnInputUploads = promptUploads.filter(
      (upload, index) => index >= input.historyUploads.length || upload.versionId
    )
    const hasTurnInputs = turnInputUploads.length > 0 || resolvedReferences.length > 0

    return {
      content: preparedContent,
      close,
      historyImageCount,
      ...(imageSources.length > 0 ? { imageSources } : {}),
      ...(hasTurnInputs
        ? {
            turnInputs: {
              uploads: turnInputUploads,
              references: resolvedReferences
            }
          }
        : {})
    }
  }

  resetSession(sessionId: string): void {
    this.options.fileReferenceResolver.resetSession(sessionId)
    for (const [connectionGeneration, sessionBytes] of this.sessionInlineImageBytes) {
      sessionBytes.delete(sessionId)
      if (sessionBytes.size === 0) this.sessionInlineImageBytes.delete(connectionGeneration)
    }
  }

  clear(): void {
    this.options.fileReferenceResolver.clear()
    this.sessionInlineImageBytes.clear()
    for (const close of [...this.activePreparedResources]) close()
  }

  clearGeneration(connectionGeneration: number): void {
    this.options.fileReferenceResolver.clearGeneration(connectionGeneration)
    this.sessionInlineImageBytes.delete(connectionGeneration)
  }

  private getSessionInlineImageBytes(input: PrepareAcpPromptContentInput): number {
    return (
      this.sessionInlineImageBytes.get(input.connectionGeneration ?? 0)?.get(input.appSessionId) ??
      0
    )
  }

  private setSessionInlineImageBytes(input: PrepareAcpPromptContentInput, bytes: number): void {
    const connectionGeneration = input.connectionGeneration ?? 0
    let sessionBytes = this.sessionInlineImageBytes.get(connectionGeneration)
    if (!sessionBytes) {
      sessionBytes = new Map()
      this.sessionInlineImageBytes.set(connectionGeneration, sessionBytes)
    }
    sessionBytes.set(input.appSessionId, bytes)
  }

  private attachCodexSkillInputs(
    content: string | ContentBlock[],
    descriptors: ReadonlyArray<CodexSkillInput>
  ): string | ContentBlock[] {
    if (descriptors.length === 0) return content

    const skillInputs = descriptors.map((descriptor) => ({ ...descriptor }))
    const metadata = { 'open-science/skill-inputs': skillInputs }
    if (typeof content === 'string') {
      return [{ type: 'text', text: content, _meta: metadata }]
    }

    const blocks = [...content]
    const textIndex = blocks.findIndex((block) => block.type === 'text')
    if (textIndex < 0) {
      blocks.unshift({ type: 'text', text: '', _meta: metadata })
      return blocks
    }

    const textBlock = blocks[textIndex]
    if (textBlock.type === 'text') {
      blocks[textIndex] = {
        ...textBlock,
        _meta: { ...(textBlock._meta ?? {}), ...metadata }
      }
    }
    return blocks
  }

  private async createAttachmentContentBlocks(
    input: PrepareAcpPromptContentInput,
    attachment: UploadedAttachment,
    isHistoryUpload: boolean,
    fileTextBudget: PromptFileTextBudget,
    snapshots: TurnResourceSnapshotStore
  ): Promise<{ attachment: UploadedAttachment; blocks: ContentBlock[] }> {
    if (!this.options.uploadRepository) throw new Error('Upload storage is not configured.')

    if (this.options.managedFileVersions) {
      const lease = await this.options.managedFileVersions.openLatest({
        source: 'upload',
        projectId: input.projectId,
        fileId: attachment.id
      })

      let prepared: { attachment: UploadedAttachment; blocks: ContentBlock[] }
      try {
        const exactAttachment: UploadedAttachment = {
          id: lease.logicalFile.id,
          versionId: lease.version.id,
          versionNumber: lease.version.versionNumber,
          sessionId: lease.logicalFile.sessionId,
          name: lease.version.filename,
          originalName: lease.logicalFile.displayName,
          path: createUploadVersionReference(lease.version.id, {
            projectId: lease.logicalFile.projectId,
            sessionId: lease.logicalFile.sessionId,
            fileId: lease.logicalFile.id
          }),
          ...(lease.version.contentType ? { mimeType: lease.version.contentType } : {}),
          size: lease.size,
          checksum: lease.version.checksum,
          createdAt: lease.version.createdAt.toISOString()
        }
        // Provider adapters may dereference file URIs after prompt preparation returns. Keep an
        // exact private copy alive for the prepared turn instead of exposing the managed path after
        // its integrity lease closes.
        const snapshot = await snapshots.create(exactAttachment.originalName, lease)
        prepared = {
          attachment: exactAttachment,
          blocks: await this.buildFileContentBlocks(
            input,
            {
              absolutePath: snapshot.absolutePath,
              uri: snapshot.uri,
              name: exactAttachment.originalName || exactAttachment.name,
              mimeType: exactAttachment.mimeType,
              size: lease.size,
              allowSkillImportReference: true,
              skillImportUri: exactAttachment.path,
              trustedLease: lease
            },
            fileTextBudget,
            isHistoryUpload,
            isHistoryUpload ? 'history-upload' : 'current-upload'
          )
        }
      } catch (error) {
        await lease.close().catch(() => undefined)
        throw error
      }
      await lease.close()
      return prepared
    }

    const filePath = await this.options.uploadRepository.resolveManagedUploadPath(
      { path: attachment.path },
      {
        projectId: input.projectId,
        ...(isHistoryUpload
          ? {}
          : {
              sessionId: attachment.versionId ? attachment.sessionId : input.appSessionId
            })
      }
    )
    const { size } = await stat(filePath)

    return {
      attachment,
      blocks: await this.buildFileContentBlocks(
        input,
        {
          absolutePath: filePath,
          uri: pathToFileURL(filePath).href,
          name: attachment.originalName || attachment.name,
          mimeType: attachment.mimeType,
          size,
          allowSkillImportReference: true
        },
        fileTextBudget,
        isHistoryUpload,
        isHistoryUpload ? 'history-upload' : 'current-upload'
      )
    }
  }

  private async createReferencedArtifactContentBlocks(
    input: PrepareAcpPromptContentInput,
    reference: FileReference,
    fileTextBudget: PromptFileTextBudget,
    snapshots: TurnResourceSnapshotStore
  ): Promise<{ blocks: ContentBlock[]; reference: FileReference }> {
    const resolvedReference = await this.options.fileReferenceResolver.resolve(
      {
        sessionId: input.appSessionId,
        projectId: input.projectId,
        connectionGeneration: input.connectionGeneration
      },
      reference
    )

    let prepared: { blocks: ContentBlock[]; reference: FileReference }
    try {
      const snapshot = resolvedReference.trustedLease
        ? await snapshots.create(resolvedReference.name, resolvedReference.trustedLease)
        : undefined
      const versionReference =
        reference.source === 'upload' &&
        resolvedReference.sourceFileId &&
        resolvedReference.sourceSessionId &&
        resolvedReference.versionId
          ? createUploadVersionReference(resolvedReference.versionId, {
              projectId: input.projectId,
              sessionId: resolvedReference.sourceSessionId,
              fileId: resolvedReference.sourceFileId
            })
          : undefined
      const promptReference = snapshot
        ? {
            ...resolvedReference,
            absolutePath: snapshot.absolutePath,
            uri: snapshot.uri,
            ...(versionReference ? { skillImportUri: versionReference } : {})
          }
        : {
            ...resolvedReference,
            ...(versionReference ? { skillImportUri: versionReference } : {})
          }
      const exactReference: FileReference =
        reference.source !== 'linked-folder' &&
        resolvedReference.sourceFileId &&
        resolvedReference.versionId
          ? {
              ...reference,
              ...(versionReference ? { path: versionReference } : {}),
              sourceFileId: resolvedReference.sourceFileId,
              name: resolvedReference.name,
              versionId: resolvedReference.versionId,
              ...(resolvedReference.checksum ? { checksum: resolvedReference.checksum } : {})
            }
          : reference
      prepared = {
        blocks: await this.buildFileContentBlocks(
          input,
          promptReference,
          fileTextBudget,
          false,
          'file-reference',
          reference.source === 'linked-folder'
            ? undefined
            : sanitizePdfReadingPosition(reference.pdfReadingPosition),
          reference.source === 'linked-folder' || !reference.pdfContextDocumentId
            ? undefined
            : {
                documentId: reference.pdfContextDocumentId,
                documentCount: Math.min(Math.max(reference.pdfContextDocumentCount ?? 1, 1), 3),
                active: reference.pdfContextActive === true
              }
        ),
        reference: exactReference
      }
    } catch (error) {
      await resolvedReference.trustedLease?.close().catch(() => undefined)
      throw error
    }
    await resolvedReference.trustedLease?.close()
    return prepared
  }

  private async readPromptFileBytes(descriptor: ResolvedPromptFile): Promise<Buffer> {
    if (!descriptor.trustedLease) return readFile(descriptor.absolutePath)
    if (descriptor.size === 0) {
      await descriptor.trustedLease.verifyUnchanged()
      return Buffer.alloc(0)
    }
    return Buffer.from(await descriptor.trustedLease.readRange(0, descriptor.size))
  }

  private async buildFileContentBlocks(
    input: PrepareAcpPromptContentInput,
    descriptor: ResolvedPromptFile,
    fileTextBudget: PromptFileTextBudget,
    isHistoryUpload: boolean,
    source: PromptFileSource,
    pdfReadingPosition?: PdfReadingPosition,
    linkedPdfContext?: LinkedPdfContext
  ): Promise<ContentBlock[]> {
    const { absolutePath, uri, skillImportUri, name, mimeType, size, allowSkillImportReference } =
      descriptor

    const attachmentTextReference = (
      tag: 'attached_skill_package' | 'attached_local_archive',
      skillImportEligible: boolean,
      turnToken?: string,
      attachmentUri: string = uri
    ): ContentBlock => ({
      type: 'text',
      text: [
        `<${tag}>`,
        JSON.stringify({
          name,
          uri: attachmentUri,
          mimeType,
          size,
          skillImportEligible,
          ...(turnToken ? { skillImportTurnToken: turnToken } : {})
        }),
        `</${tag}>`
      ].join('\n')
    })
    const localFileTextReference = (notice: string): ContentBlock => ({
      type: 'text',
      text: [
        notice,
        '<attached_local_file>',
        JSON.stringify({ name, uri, mimeType, size }),
        '</attached_local_file>'
      ].join('\n')
    })

    const normalizedName = name.toLowerCase()
    const normalizedMimeType = mimeEssence(mimeType)
    const isArchive =
      normalizedName.endsWith('.zip') ||
      normalizedName.endsWith('.skill') ||
      normalizedMimeType === 'application/zip' ||
      normalizedMimeType === 'application/x-zip-compressed'
    const imageMimeType = imageAttachmentMimeType(name, mimeType)

    // A replayed raster may still be required by the selected conversational turn. Every other
    // historical file remains a descriptor: formats that downstream agents can safely represent
    // keep their resource link, while binary formats become provider-neutral local-file text.
    if (isHistoryUpload && !imageMimeType) {
      if (this.isPdfFile(name, mimeType) || isTextLikeAttachment(name, mimeType)) {
        return [{ type: 'resource_link', uri, name, title: name, mimeType, size }]
      }
      if (isArchive) return [attachmentTextReference('attached_local_archive', false)]
      const notice = isDatasetAttachment(name, mimeType)
        ? buildDatasetAttachmentNotice({ name, size })
        : buildLocalFileAttachmentNotice({ name, size })
      return [localFileTextReference(notice)]
    }

    if (
      input.skillImportEnabled &&
      allowSkillImportReference &&
      (await this.isSkillPackageFile(name, descriptor))
    ) {
      const turnToken = input.skillImportTurnToken
      if (turnToken) {
        const attachmentUri = skillImportUri ?? uri
        try {
          input.onSkillImportAttachmentEligible?.(attachmentUri)
        } catch {
          // Eligibility notification is observational and must not abort prompt preparation.
        }
        return [attachmentTextReference('attached_skill_package', true, turnToken, attachmentUri)]
      }
    }

    if (isArchive) {
      return [attachmentTextReference('attached_local_archive', false)]
    }

    if (imageMimeType) {
      if (size > MAX_AUTO_PROCESS_IMAGE_BYTES) {
        const resourceLink: ContentBlock = {
          type: 'resource_link',
          uri,
          name,
          title: name,
          mimeType: imageMimeType,
          size
        }
        if (input.imageCompatibilityRelay) return [resourceLink]
        return [
          {
            type: 'text',
            text: buildDeferredMediaNotice({ name, size, kind: 'image' })
          },
          resourceLink
        ]
      }
      const { data, mimeType: outMimeType } = await buildImageContentData(
        absolutePath,
        imageMimeType,
        size,
        descriptor.trustedLease ? () => this.readPromptFileBytes(descriptor) : undefined
      )

      if (!input.imageCompatibilityRelay) {
        const alreadyInlined = this.getSessionInlineImageBytes(input)
        if (!canInlineImageInSession(alreadyInlined, data.length, this.inlineImageBudgetBytes)) {
          return [{ type: 'resource_link', uri, name, title: name, mimeType: imageMimeType, size }]
        }

        // Charge before the request-level append. Existing behavior retains this charge even if a
        // later reference fails or the request image budget rejects this block.
        this.setSessionInlineImageBytes(input, alreadyInlined + data.length)
      }
      return [{ type: 'image', data, mimeType: outMimeType, uri }]
    }

    if (this.isPdfFile(name, mimeType)) {
      const pdfScope = resolvePdfPreparationScope(input.text, pdfReadingPosition)
      const targetPageNumber =
        pdfScope === 'current-page' ? pdfReadingPosition?.pageNumber : undefined
      const retrievalMode = targetPageNumber ? 'page-snapshot' : 'document-extraction'
      if (linkedPdfContext && pdfScope === 'full-document') {
        const collectionRequested = PDF_COLLECTION_INTENT.test(input.text)
        const text = [
          ...(pdfReadingPosition ? [buildPdfReadingContext(name, pdfReadingPosition)] : []),
          '<linked_pdf_reading_route>',
          JSON.stringify({
            documentId: linkedPdfContext.documentId,
            name,
            documentCount: linkedPdfContext.documentCount,
            active: linkedPdfContext.active,
            pageCount: pdfReadingPosition?.pageCount,
            route: 'literature-mcp',
            target: collectionRequested ? 'linked-collection' : 'active-document',
            fullTextEmbedded: false
          }),
          '</linked_pdf_reading_route>',
          ...(linkedPdfContext.active
            ? [
                collectionRequested
                  ? 'For whole-document synthesis across the linked collection, call `read_document` separately for each linked documentId and read every sequential batch until nextCursor is null.'
                  : `For whole-document synthesis, call \`read_document\` with documentId ${JSON.stringify(linkedPdfContext.documentId)} and read every sequential batch until nextCursor is null.`,
                'Do not call MCP resource-discovery tools, and do not use Notebook, shell, filesystem, or Python to extract linked PDFs.'
              ]
            : [])
        ].join('\n')
        log.info('PDF prepared for Agent', {
          sessionId: input.appSessionId,
          source,
          retrievalMode: 'literature-tool',
          scope: pdfScope,
          routingReason: 'intent-full-document',
          documentCount: linkedPdfContext.documentCount,
          collectionRequested,
          pageCount: pdfReadingPosition?.pageCount,
          deliveryMode: 'literature-mcp-reference',
          injectedChars: text.length,
          fullDocumentInjected: false,
          bm25Status: 'not-requested'
        })
        return [{ type: 'text', text }]
      }
      if (linkedPdfContext && pdfScope === 'auto') {
        const text = [
          ...(pdfReadingPosition ? [buildPdfReadingContext(name, pdfReadingPosition)] : []),
          '<linked_pdf_reading_route>',
          JSON.stringify({
            documentId: linkedPdfContext.documentId,
            name,
            documentCount: linkedPdfContext.documentCount,
            active: linkedPdfContext.active,
            pageCount: pdfReadingPosition?.pageCount,
            route: 'literature-mcp',
            retrieval: 'query',
            fullTextEmbedded: false
          }),
          '</linked_pdf_reading_route>',
          ...(linkedPdfContext.active
            ? [
                'For questions about linked literature, call `read_document` with a focused query and omit documentIds to retrieve relevant passages across all linked PDFs. Use documentIds only when the user identifies a subset. Use sequential batches only for whole-document synthesis.',
                'Do not call MCP resource-discovery tools, and do not use Notebook, shell, filesystem, or Python to extract linked PDFs.'
              ]
            : [])
        ].join('\n')
        log.info('PDF prepared for Agent', {
          sessionId: input.appSessionId,
          source,
          retrievalMode: 'literature-tool',
          scope: pdfScope,
          routingReason: 'intent-auto',
          pageNumber: pdfReadingPosition?.pageNumber,
          pageCount: pdfReadingPosition?.pageCount,
          documentCount: linkedPdfContext.documentCount,
          deliveryMode: 'literature-mcp-reference',
          injectedChars: text.length,
          fullDocumentInjected: false,
          bm25Status: 'pending-read-document-query'
        })
        return [{ type: 'text', text }]
      }
      if (size > MAX_AUTO_EXTRACT_PDF_BYTES) {
        const blocks: ContentBlock[] = [
          ...(pdfReadingPosition
            ? [
                {
                  type: 'text' as const,
                  text: buildPdfReadingContext(name, pdfReadingPosition)
                }
              ]
            : []),
          {
            type: 'text',
            text: buildDeferredMediaNotice({ name, size, kind: 'PDF' })
          },
          { type: 'resource_link', uri, name, title: name, mimeType: 'application/pdf', size }
        ]
        log.info('PDF prepared for Agent', {
          sessionId: input.appSessionId,
          source,
          retrievalMode,
          scope: pdfScope,
          routingReason: `intent-${pdfScope}`,
          pageNumber: targetPageNumber,
          pageCount: pdfReadingPosition?.pageCount,
          deliveryMode: 'deferred-resource-link',
          fullDocumentInjected: false,
          bm25Used: false,
          bm25ResultCount: null,
          sourceBytes: size,
          extractionLimitBytes: MAX_AUTO_EXTRACT_PDF_BYTES
        })
        return blocks
      }
      const budgetBefore = fileTextBudget.remaining
      const extraction = await this.createPdfContentBlock(
        name,
        absolutePath,
        uri,
        pdfReadingPosition,
        pdfScope
      )
      const blocks = await this.admitTextResource(
        extraction.block,
        descriptor,
        fileTextBudget,
        false
      )
      const deliveryMode = blocks.some((block) => block.type === 'resource')
        ? 'extracted-text-resource'
        : blocks.some((block) => block.type === 'text')
          ? 'budgeted-text-preview'
          : 'resource-link'
      const injectedChars = blocks.reduce((total, block) => {
        if (block.type === 'text') return total + block.text.length
        if (block.type === 'resource' && 'text' in block.resource) {
          return total + block.resource.text.length
        }
        return total
      }, 0)
      log.info('PDF prepared for Agent', {
        sessionId: input.appSessionId,
        source,
        retrievalMode,
        scope: pdfScope,
        routingReason: `intent-${pdfScope}`,
        pageNumber: targetPageNumber,
        deliveryMode,
        extractionStatus: extraction.status,
        pageCount: extraction.pageCount,
        extractedChars: extraction.extractedChars,
        injectedChars,
        extractorTruncated: extraction.extractorTruncated,
        fullDocumentInjected:
          extraction.status === 'extracted' &&
          pdfScope !== 'current-page' &&
          !extraction.extractorTruncated &&
          deliveryMode === 'extracted-text-resource',
        fileTextBudgetBefore: budgetBefore,
        fileTextBudgetAfter: fileTextBudget.remaining,
        bm25Used: false,
        bm25ResultCount: null
      })
      return blocks
    }

    if (isTextLikeAttachment(name, mimeType)) {
      if (size <= MAX_EMBEDDED_TEXT_UPLOAD_BYTES) {
        const block: ContentBlock = {
          type: 'resource',
          resource: {
            uri,
            mimeType,
            text: (await this.readPromptFileBytes(descriptor)).toString('utf8')
          }
        }
        return this.admitTextResource(
          block,
          descriptor,
          fileTextBudget,
          isTabularAttachment(name, mimeType)
        )
      }
      return this.createBudgetedTextPreview(
        descriptor,
        fileTextBudget,
        isTabularAttachment(name, mimeType)
      )
    }

    if (isDatasetAttachment(name, mimeType)) {
      return [localFileTextReference(buildDatasetAttachmentNotice({ name, size }))]
    }

    return [localFileTextReference(buildLocalFileAttachmentNotice({ name, size }))]
  }

  private async admitTextResource(
    block: ContentBlock,
    descriptor: ResolvedPromptFile,
    budget: PromptFileTextBudget,
    tabular: boolean
  ): Promise<ContentBlock[]> {
    if (block.type !== 'resource' || !('text' in block.resource)) return [block]

    const cost = estimateHistoryTokens(block.resource.text)
    const allowance = Math.min(budget.remaining, budget.perFileLimit)
    if (cost <= allowance) {
      budget.remaining -= cost
      return [block]
    }

    return this.createBudgetedTextPreview(descriptor, budget, tabular, block.resource.text)
  }

  private async createBudgetedTextPreview(
    descriptor: ResolvedPromptFile,
    budget: PromptFileTextBudget,
    tabular: boolean,
    sourceText?: string
  ): Promise<ContentBlock[]> {
    const { absolutePath, uri, name, mimeType, size } = descriptor
    const fallback: ContentBlock[] = [
      { type: 'resource_link', uri, name, title: name, mimeType, size }
    ]
    const allowance = Math.min(budget.remaining, budget.perFileLimit)
    if (allowance <= 0) return fallback

    const toBlock = (preview: string): Extract<ContentBlock, { type: 'text' }> => ({
      type: 'text',
      text: [
        buildOversizedAttachmentNotice({
          name,
          size,
          preview,
          truncated: true,
          tabular
        }),
        '<attached_local_file>',
        JSON.stringify({ name, uri, mimeType, size }),
        '</attached_local_file>'
      ].join('\n')
    })
    const fixedCost = estimateHistoryTokens(toBlock('').text)
    if (fixedCost >= allowance) return fallback

    const previewBudget = allowance - fixedCost
    let rawPreview: string
    if (sourceText !== undefined) {
      rawPreview = sourceText
    } else {
      const previewBytes = Math.min(ATTACHMENT_PREVIEW_BYTES, Math.max(256, previewBudget * 3))
      const startBytes = tabular ? previewBytes : Math.ceil(previewBytes / 2)
      const readPreview = (
        request: Parameters<typeof readBoundedManagedFilePreview>[1]
      ): ReturnType<typeof readBoundedManagedFilePreview> =>
        descriptor.trustedLease
          ? readBoundedManagedFilePreviewLease(
              descriptor.trustedLease,
              request,
              'Attachment preview requires UTF-8 encoding.'
            )
          : readBoundedManagedFilePreview(
              absolutePath,
              request,
              'Attachment preview requires UTF-8 encoding.'
            )
      const start = await readPreview({
        path: absolutePath,
        maxBytes: startBytes,
        encoding: 'utf8'
      })
      if (tabular) {
        rawPreview = start.content
      } else {
        const endBytes = Math.max(1, previewBytes - startBytes)
        const end = await readPreview({
          path: absolutePath,
          offset: Math.max(0, size - endBytes),
          maxBytes: endBytes,
          encoding: 'utf8'
        })
        rawPreview = `${start.content}\n\n[…middle of file omitted…]\n\n${end.content}`
      }
    }

    let preview = truncateTextToEstimatedTokens(
      rawPreview,
      previewBudget,
      tabular ? 'start' : 'both'
    )
    let block = toBlock(preview)
    let cost = estimateHistoryTokens(block.text)
    if (cost > allowance) {
      preview = truncateTextToEstimatedTokens(
        preview,
        Math.max(0, previewBudget - (cost - allowance)),
        tabular ? 'start' : 'both'
      )
      block = toBlock(preview)
      cost = estimateHistoryTokens(block.text)
    }
    if (cost > allowance) return fallback

    budget.remaining -= cost
    return [block]
  }

  private imageOverflowResourceLink(
    block: ContentBlock,
    name: string,
    size?: number
  ): ContentBlock | undefined {
    if (block.type !== 'image' || !block.uri) return undefined

    return {
      type: 'resource_link',
      uri: block.uri,
      name,
      title: name,
      mimeType: block.mimeType,
      size
    }
  }

  private isPdfFile(name: string, mimeType?: string): boolean {
    if (mimeType === 'application/pdf') return true
    return name.toLowerCase().endsWith('.pdf')
  }

  private async isSkillPackageFile(name: string, descriptor: ResolvedPromptFile): Promise<boolean> {
    const normalizedName = name.toLowerCase()
    if (!normalizedName.endsWith('.skill') && !normalizedName.endsWith('.zip')) return false
    if (!descriptor.trustedLease) {
      return isImportableSkillArchivePath(descriptor.absolutePath)
    }
    const lease = descriptor.trustedLease
    return isImportableSkillArchive({
      size: descriptor.size,
      read: async (position, length) => {
        if (
          !Number.isSafeInteger(position) ||
          !Number.isSafeInteger(length) ||
          position < 0 ||
          length < 0 ||
          position + length > descriptor.size
        ) {
          return undefined
        }
        if (length === 0) {
          await lease.verifyUnchanged()
          return Buffer.alloc(0)
        }
        return Buffer.from(await lease.readRange(position, position + length))
      }
    })
  }

  private async createPdfContentBlock(
    name: string,
    filePath: string,
    uri: string,
    readingPosition: PdfReadingPosition | undefined,
    scope: PdfPreparationScope
  ): Promise<PdfExtractionResult> {
    const toResource = (text: string): ContentBlock => ({
      type: 'resource',
      resource: { uri, mimeType: 'text/plain', text }
    })

    try {
      const { text, pageCount, truncated } = await extractPdfText(
        filePath,
        scope === 'current-page' ? readingPosition?.pageNumber : undefined
      )
      if (!text) {
        const pageNumber = readingPosition
          ? Math.min(readingPosition.pageNumber, pageCount)
          : undefined
        return {
          block: toResource(
            [
              ...(pageNumber ? [buildPdfReadingContext(name, { pageNumber, pageCount })] : []),
              `[No selectable text could be extracted from "${name}" (${pageCount} page(s)). It may be a scanned or image-only PDF.]`
            ].join('\n\n')
          ),
          status: 'no-selectable-text',
          pageCount,
          extractedChars: 0,
          extractorTruncated: false
        }
      }

      if (readingPosition && scope === 'current-page') {
        const pageNumber = Math.min(readingPosition.pageNumber, pageCount)
        return {
          block: toResource(
            [buildPdfReadingContext(name, { pageNumber, pageCount }), text].join('\n\n')
          ),
          status: 'extracted',
          pageCount,
          extractedChars: text.length,
          extractorTruncated: truncated
        }
      }

      const header = `[PDF text extracted from "${name}" — ${pageCount} page(s)${
        truncated ? ', truncated' : ''
      }]`
      return {
        block: toResource(
          [
            ...(readingPosition ? [buildPdfReadingContext(name, readingPosition)] : []),
            header,
            text
          ].join('\n\n')
        ),
        status: 'extracted',
        pageCount,
        extractedChars: text.length,
        extractorTruncated: truncated
      }
    } catch (error) {
      return {
        block: toResource(
          `[Failed to extract text from "${name}": ${errorMessage(error)}. The PDF was not sent to avoid exceeding the request size limit.]`
        ),
        status: 'failed',
        extractedChars: 0,
        extractorTruncated: false
      }
    }
  }
}

export { AcpPromptContentOwner, resolvePdfPreparationScope }
export type {
  AcpPromptContentOwnerOptions,
  AcpPromptTurnInputs,
  CodexSkillInput,
  PrepareAcpPromptContentInput,
  PreparedAcpPromptContent
}
