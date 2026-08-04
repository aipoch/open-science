import type { ContentBlock } from '@agentclientprotocol/sdk'
import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import type { AcpMessageImage } from '../../shared/acp'
import type { FileReference } from '../../shared/artifacts'
import type { UploadedAttachment } from '../../shared/uploads'
import { readBoundedManagedFilePreview } from '../managed-file-preview'
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
import type { UploadRepository } from '../uploads/repository'
import { isImportableSkillArchivePath } from '../skills/skill-archive-sniffer'
import {
  ATTACHMENT_PREVIEW_BYTES,
  MAX_EMBEDDED_TEXT_UPLOAD_BYTES,
  buildDatasetAttachmentNotice,
  buildDeferredMediaNotice,
  buildOversizedAttachmentNotice,
  imageAttachmentMimeType,
  isDatasetAttachment,
  isTabularAttachment,
  isTextLikeAttachment,
  mimeEssence
} from './attachment-content'
import type { FileReferenceResolver } from './file-reference-resolver'

type CodexSkillInput = {
  name: string
  path: string
}

type AcpPromptContentOwnerOptions = {
  uploadRepository?: UploadRepository
  fileReferenceResolver: FileReferenceResolver
  inlineImageBudgetBytes?: number
}

type PrepareAcpPromptContentInput = {
  appSessionId: string
  projectId: string
  text: string
  historyImages: ReadonlyArray<AcpMessageImage>
  historyUploads: ReadonlyArray<UploadedAttachment>
  currentUploads: ReadonlyArray<UploadedAttachment>
  references: ReadonlyArray<FileReference>
  codexSkillInputs: ReadonlyArray<CodexSkillInput>
  skillImportEnabled: boolean
  skillImportTurnToken?: string
  onSkillImportAttachmentEligible?: (attachmentUri: string) => void
}

type AcpPromptTurnInputs = {
  uploads: UploadedAttachment[]
  references: FileReference[]
}

type PreparedAcpPromptContent = {
  content: string | ContentBlock[]
  turnInputs?: AcpPromptTurnInputs
}

type ResolvedPromptFile = {
  absolutePath: string
  uri: string
  name: string
  mimeType?: string
  size: number
  allowSkillImportReference: boolean
}

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
  private readonly sessionInlineImageBytes = new Map<string, number>()
  private readonly inlineImageBudgetBytes: number

  constructor(private readonly options: AcpPromptContentOwnerOptions) {
    this.inlineImageBudgetBytes = options.inlineImageBudgetBytes ?? MAX_SESSION_INLINE_IMAGE_BYTES
  }

  async prepare(input: PrepareAcpPromptContentInput): Promise<PreparedAcpPromptContent> {
    const attachments = [...input.historyUploads, ...input.currentUploads]
    let finalizedPromptUploads: UploadedAttachment[] = []

    let content: string | ContentBlock[]
    if (
      attachments.length === 0 &&
      input.references.length === 0 &&
      input.historyImages.length === 0
    ) {
      content = input.text
    } else {
      const contentBlocks: ContentBlock[] = input.text.trim()
        ? [{ type: 'text', text: input.text }]
        : []
      let imageBudget: InlineImageBudget = { imageCount: 0, base64Bytes: 0 }
      const appendBlock = (block: ContentBlock, overflowFallback?: ContentBlock): void => {
        if (block.type === 'image') {
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
              if (overflowFallback) contentBlocks.push(overflowFallback)
              return
            }
            throw error
          }
        }
        contentBlocks.push(block)
      }

      for (const image of input.historyImages) {
        appendBlock({ type: 'image', data: image.data, mimeType: image.mimeType })
      }
      if (input.historyImages.length > 0) {
        this.sessionInlineImageBytes.set(input.appSessionId, imageBudget.base64Bytes)
      }

      // Staged uploads own the durable Session id here, so finalize before turning them into blocks.
      if (attachments.length > 0) {
        if (!this.options.uploadRepository) throw new Error('Upload storage is not configured.')

        finalizedPromptUploads = await this.options.uploadRepository.finalizePendingSessionUploads(
          input.appSessionId,
          attachments,
          input.projectId
        )

        // Preserve the existing order: history uploads, current uploads, then explicit references.
        for (const attachment of finalizedPromptUploads) {
          const blocks = await this.createAttachmentContentBlocks(input, attachment)
          for (const block of blocks) {
            appendBlock(
              block,
              this.imageOverflowResourceLink(block, attachment.originalName, attachment.size)
            )
          }
        }
      }

      for (const reference of input.references) {
        const blocks = await this.createReferencedArtifactContentBlocks(input, reference)
        for (const block of blocks) {
          appendBlock(block, this.imageOverflowResourceLink(block, reference.name))
        }
      }

      content = contentBlocks
    }

    const preparedContent = this.attachCodexSkillInputs(content, input.codexSkillInputs)
    const hasTurnInputs = finalizedPromptUploads.length > 0 || input.references.length > 0

    return {
      content: preparedContent,
      ...(hasTurnInputs
        ? {
            turnInputs: {
              uploads: finalizedPromptUploads,
              references: [...input.references]
            }
          }
        : {})
    }
  }

  resetSession(sessionId: string): void {
    this.sessionInlineImageBytes.delete(sessionId)
  }

  clear(): void {
    this.sessionInlineImageBytes.clear()
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
    attachment: UploadedAttachment
  ): Promise<ContentBlock[]> {
    if (!this.options.uploadRepository) throw new Error('Upload storage is not configured.')

    const filePath = await this.options.uploadRepository.resolveManagedUploadPath(
      { path: attachment.path },
      { projectId: input.projectId, sessionId: input.appSessionId }
    )
    const { size } = await stat(filePath)

    return this.buildFileContentBlocks(input, {
      absolutePath: filePath,
      uri: pathToFileURL(filePath).href,
      name: attachment.originalName || attachment.name,
      mimeType: attachment.mimeType,
      size,
      allowSkillImportReference: true
    })
  }

  private async createReferencedArtifactContentBlocks(
    input: PrepareAcpPromptContentInput,
    reference: FileReference
  ): Promise<ContentBlock[]> {
    const resolvedReference = await this.options.fileReferenceResolver.resolve(
      { sessionId: input.appSessionId, projectId: input.projectId },
      reference
    )

    return this.buildFileContentBlocks(input, resolvedReference)
  }

  private async buildFileContentBlocks(
    input: PrepareAcpPromptContentInput,
    descriptor: ResolvedPromptFile
  ): Promise<ContentBlock[]> {
    const { absolutePath, uri, name, mimeType, size, allowSkillImportReference } = descriptor

    const attachmentTextReference = (
      tag: 'attached_skill_package' | 'attached_local_archive',
      skillImportEligible: boolean,
      turnToken?: string
    ): ContentBlock => ({
      type: 'text',
      text: [
        `<${tag}>`,
        JSON.stringify({
          name,
          uri,
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

    if (
      input.skillImportEnabled &&
      allowSkillImportReference &&
      (await this.isSkillPackageFile(name, absolutePath))
    ) {
      const turnToken = input.skillImportTurnToken
      if (turnToken) {
        try {
          input.onSkillImportAttachmentEligible?.(uri)
        } catch {
          // Eligibility notification is observational and must not abort prompt preparation.
        }
        return [attachmentTextReference('attached_skill_package', true, turnToken)]
      }
    }

    const normalizedName = name.toLowerCase()
    const normalizedMimeType = mimeEssence(mimeType)
    if (
      normalizedName.endsWith('.zip') ||
      normalizedName.endsWith('.skill') ||
      normalizedMimeType === 'application/zip' ||
      normalizedMimeType === 'application/x-zip-compressed'
    ) {
      return [attachmentTextReference('attached_local_archive', false)]
    }

    const imageMimeType = imageAttachmentMimeType(name, mimeType)
    if (imageMimeType) {
      if (size > MAX_AUTO_PROCESS_IMAGE_BYTES) {
        return [
          {
            type: 'text',
            text: buildDeferredMediaNotice({ name, size, kind: 'image' })
          },
          { type: 'resource_link', uri, name, title: name, mimeType: imageMimeType, size }
        ]
      }
      const { data, mimeType: outMimeType } = await buildImageContentData(
        absolutePath,
        imageMimeType,
        size
      )

      const alreadyInlined = this.sessionInlineImageBytes.get(input.appSessionId) ?? 0
      if (!canInlineImageInSession(alreadyInlined, data.length, this.inlineImageBudgetBytes)) {
        return [{ type: 'resource_link', uri, name, title: name, mimeType: imageMimeType, size }]
      }

      // Charge before the request-level append. Existing behavior retains this charge even if a later
      // reference fails or the request image budget rejects this block.
      this.sessionInlineImageBytes.set(input.appSessionId, alreadyInlined + data.length)
      return [{ type: 'image', data, mimeType: outMimeType, uri }]
    }

    if (this.isPdfFile(name, mimeType)) {
      if (size > MAX_AUTO_EXTRACT_PDF_BYTES) {
        return [
          {
            type: 'text',
            text: buildDeferredMediaNotice({ name, size, kind: 'PDF' })
          },
          { type: 'resource_link', uri, name, title: name, mimeType: 'application/pdf', size }
        ]
      }
      return [await this.createPdfContentBlock(name, absolutePath, uri)]
    }

    if (isTextLikeAttachment(name, mimeType)) {
      if (size <= MAX_EMBEDDED_TEXT_UPLOAD_BYTES) {
        return [
          {
            type: 'resource',
            resource: { uri, mimeType, text: await readFile(absolutePath, 'utf8') }
          }
        ]
      }

      const preview = await readBoundedManagedFilePreview(
        absolutePath,
        { path: absolutePath, maxBytes: ATTACHMENT_PREVIEW_BYTES, encoding: 'utf8' },
        'Attachment preview requires UTF-8 encoding.'
      )

      return [
        localFileTextReference(
          buildOversizedAttachmentNotice({
            name,
            size,
            preview: preview.content,
            truncated: preview.truncated,
            tabular: isTabularAttachment(name, mimeType)
          })
        )
      ]
    }

    if (isDatasetAttachment(name, mimeType)) {
      return [localFileTextReference(buildDatasetAttachmentNotice({ name, size }))]
    }

    return [{ type: 'resource_link', uri, name, title: name, mimeType, size }]
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

  private async isSkillPackageFile(name: string, filePath: string): Promise<boolean> {
    const normalizedName = name.toLowerCase()
    if (!normalizedName.endsWith('.skill') && !normalizedName.endsWith('.zip')) return false
    return isImportableSkillArchivePath(filePath)
  }

  private async createPdfContentBlock(
    name: string,
    filePath: string,
    uri: string
  ): Promise<ContentBlock> {
    const toResource = (text: string): ContentBlock => ({
      type: 'resource',
      resource: { uri, mimeType: 'text/plain', text }
    })

    try {
      const { text, pageCount, truncated } = await extractPdfText(filePath)
      if (!text) {
        return toResource(
          `[No selectable text could be extracted from "${name}" (${pageCount} page(s)). It may be a scanned or image-only PDF.]`
        )
      }

      const header = `[PDF text extracted from "${name}" — ${pageCount} page(s)${
        truncated ? ', truncated' : ''
      }]`
      return toResource(`${header}\n\n${text}`)
    } catch (error) {
      return toResource(
        `[Failed to extract text from "${name}": ${errorMessage(error)}. The PDF was not sent to avoid exceeding the request size limit.]`
      )
    }
  }
}

export { AcpPromptContentOwner }
export type {
  AcpPromptContentOwnerOptions,
  AcpPromptTurnInputs,
  CodexSkillInput,
  PrepareAcpPromptContentInput,
  PreparedAcpPromptContent
}
