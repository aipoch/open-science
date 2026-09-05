import type { SessionPdfSourceKind } from '../../shared/session-persistence'
import type {
  ImmutableInputAuthority,
  ImmutableInputContentLease
} from '../immutable-input-authority'
import type {
  LiteratureAttachmentAuthority,
  ResolvedLiteratureAttachmentVersion
} from './attachment-authority'

type ResolvedSessionPdfVersionBase = Readonly<{
  sourceFileId: string
  sourceVersionId: string
  filename: string
  contentType?: string
  sizeBytes: number
  checksum: string
  path: string
  openContent?: () => Promise<ImmutableInputContentLease>
}>

type ResolvedSessionPdfVersion = ResolvedSessionPdfVersionBase &
  (
    | Readonly<{
        sourceKind: 'artifact-version' | 'upload-version'
        sourceSessionId: string
      }>
    | Readonly<{
        sourceKind: 'literature-attachment-version'
        sourceSessionId?: never
      }>
  )

type SessionPdfSourceResolverOptions = Readonly<{
  inputs: Pick<ImmutableInputAuthority, 'resolveVersion' | 'openContent'>
  literature: Pick<LiteratureAttachmentAuthority, 'resolveVersion'>
}>

const resolvedLiteratureVersion = (
  version: ResolvedLiteratureAttachmentVersion
): ResolvedSessionPdfVersion => ({
  sourceKind: 'literature-attachment-version',
  sourceFileId: version.attachmentId,
  sourceVersionId: version.versionId,
  filename: version.filename,
  contentType: version.contentType,
  sizeBytes: version.sizeBytes,
  checksum: version.checksum,
  path: version.path
})

class SessionPdfSourceResolver {
  constructor(private readonly options: SessionPdfSourceResolverOptions) {}

  async resolveVersion(request: {
    projectId: string
    sourceKind: SessionPdfSourceKind
    sourceVersionId: string
    expectedSourceFileId?: string
  }): Promise<ResolvedSessionPdfVersion | undefined> {
    if (request.sourceKind === 'literature-attachment-version') {
      const version = await this.options.literature.resolveVersion(request.sourceVersionId)
      if (
        !version ||
        (request.expectedSourceFileId && version.attachmentId !== request.expectedSourceFileId)
      ) {
        return undefined
      }
      return resolvedLiteratureVersion(version)
    }

    const input = await this.options.inputs.resolveVersion({
      projectId: request.projectId,
      sourceKind: request.sourceKind,
      inputFileVersionId: request.sourceVersionId,
      expectedSourceFileId: request.expectedSourceFileId
    })
    if (!input) return undefined
    return {
      sourceKind: input.sourceKind,
      sourceFileId: input.sourceFileId,
      sourceVersionId: input.inputFileVersionId,
      sourceSessionId: input.sourceSessionId,
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      checksum: input.checksum,
      // The path is only an identity hint for managed Artifact/Upload versions. Consumers must
      // acquire the lease before reading so replacement/deletion races remain detectable.
      path: input.storageKey,
      openContent: () => this.options.inputs.openContent(input)
    }
  }
}

export { SessionPdfSourceResolver }
export type { ResolvedSessionPdfVersion, SessionPdfSourceResolverOptions }
