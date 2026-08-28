import type { FileReference } from '../../shared/artifacts'
import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import { parseNotebookInputPreviewKey, type NotebookRunInputFile } from '../../shared/notebook'
import type { UploadedAttachment } from '../../shared/uploads'
import type { ImmutableInputAuthority } from '../immutable-input-authority'
import { readBoundedManagedFilePreview } from '../managed-file-preview'

type RegisterNotebookTurnInputsRequest = {
  projectId: string
  appSessionId: string
  promptMessageId: string
  uploads: UploadedAttachment[]
  references: FileReference[]
}

type GetNotebookTurnInputsRequest = Pick<
  RegisterNotebookTurnInputsRequest,
  'projectId' | 'appSessionId' | 'promptMessageId'
>

type ResolveNotebookInputPreviewRequest = {
  projectId: string
  sourceKind: NotebookRunInputFile['sourceKind']
  inputFileVersionId: string
}

type OpenNotebookInputRunRequest = GetNotebookTurnInputsRequest & {
  artifactVersionInputs?: readonly string[]
}

type ResolveNotebookInputRunRequest = Pick<
  NotebookRunInputFile,
  'sourceKind' | 'inputFileVersionId'
>

type NotebookInputPreviewTarget = {
  sourceKind: NotebookRunInputFile['sourceKind']
  inputFileVersionId: string
  filename: string
  contentType?: string
  sizeBytes: number
  checksum: string
  absolutePath: string
}

type NotebookInputRegistryOptions = {
  inputAuthority: Pick<
    ImmutableInputAuthority,
    'resolveContent' | 'resolveVersion' | 'validateVersion'
  >
}

type RegisteredTurn = {
  fingerprint: string
  inputs: NotebookRunInputFile[]
}

const turnKey = (request: GetNotebookTurnInputsRequest): string =>
  JSON.stringify([request.projectId, request.appSessionId, request.promptMessageId])

const versionKey = (input: NotebookRunInputFile): string =>
  `${input.sourceKind}\0${input.inputFileVersionId}`

// One execution-scoped capability. It never resolves arbitrary paths: callers must name an exact
// registered Version key, and only that live record is upgraded to resolver-accessed.
class NotebookInputRunLease {
  private readonly inputsByVersion = new Map<string, NotebookRunInputFile>()
  private closed = false

  constructor(
    private readonly inputFiles: NotebookRunInputFile[],
    private readonly resolveContent: (input: NotebookRunInputFile) => Promise<string>
  ) {
    for (const input of inputFiles) this.inputsByVersion.set(versionKey(input), input)
  }

  // The main-process runtime bridge owns this live array for the duration of the run. Association
  // mutations made by resolve() are therefore present when the completed run replaces its initial row.
  getRunInputFiles(): NotebookRunInputFile[] {
    if (this.closed) throw new Error('Notebook input run lease is closed.')
    return this.inputFiles
  }

  async resolve(request: ResolveNotebookInputRunRequest): Promise<string> {
    if (this.closed) throw new Error('Notebook input run lease is closed.')
    const input = this.inputsByVersion.get(`${request.sourceKind}\0${request.inputFileVersionId}`)
    if (!input) {
      throw new Error(
        `Notebook input is not registered for this run: ${request.inputFileVersionId}`
      )
    }
    const path = await this.resolveContent(input)
    input.association = 'resolver-accessed'
    return path
  }

  close(): NotebookRunInputFile[] {
    if (!this.closed) this.closed = true
    return this.inputFiles.map((input) => ({ ...input }))
  }
}

class NotebookInputRegistry {
  private readonly turns = new Map<string, RegisteredTurn>()

  constructor(private readonly options: NotebookInputRegistryOptions) {}

  async registerTurn(request: RegisterNotebookTurnInputsRequest): Promise<void> {
    const inputs: NotebookRunInputFile[] = []
    for (const upload of request.uploads) {
      if (!upload.versionId) {
        throw new Error(`Upload input has no immutable Version identity: ${upload.originalName}`)
      }
      inputs.push(
        await this.resolveVersion({
          projectId: request.projectId,
          sourceKind: 'upload-version',
          inputFileVersionId: upload.versionId,
          expectedSourceFileId: upload.id
        })
      )
    }

    for (const reference of request.references) {
      if (reference.source === 'linked-folder') continue
      if (!reference.versionId) {
        // Legacy Project Files remain valid prompt attachments, but they cannot establish an
        // immutable Notebook input edge until their storage identity is upgraded to a Version.
        continue
      }
      inputs.push(
        await this.resolveVersion({
          projectId: request.projectId,
          sourceKind: reference.source === 'upload' ? 'upload-version' : 'artifact-version',
          inputFileVersionId: reference.versionId
        })
      )
    }

    const deduplicated = [...new Map(inputs.map((input) => [versionKey(input), input])).values()]
    const fingerprint = JSON.stringify(
      deduplicated.map((input) => [input.sourceKind, input.sourceFileId, input.inputFileVersionId])
    )
    const key = turnKey(request)
    const existing = this.turns.get(key)
    if (existing && existing.fingerprint !== fingerprint) {
      throw new Error('Notebook turn inputs conflict with an existing immutable registration.')
    }
    this.turns.set(key, { fingerprint, inputs: deduplicated })
  }

  getTurnInputs(request: GetNotebookTurnInputsRequest): NotebookRunInputFile[] {
    return (this.turns.get(turnKey(request))?.inputs ?? []).map((input) => ({ ...input }))
  }

  async openRun(request: OpenNotebookInputRunRequest): Promise<NotebookInputRunLease> {
    const registered = this.turns.get(turnKey(request))?.inputs ?? []
    const workflowArtifacts = await Promise.all(
      [...new Set(request.artifactVersionInputs ?? [])].map((inputFileVersionId) =>
        this.resolveVersion({
          projectId: request.projectId,
          sourceKind: 'artifact-version',
          inputFileVersionId
        })
      )
    )
    const requested = [
      ...new Map(
        [...registered, ...workflowArtifacts].map((input) => [versionKey(input), input])
      ).values()
    ]
    const inputs = await Promise.all(
      requested.map(async (input) => {
        const validation = await this.options.inputAuthority.validateVersion(
          request.projectId,
          input
        )
        if (validation.state !== 'available') {
          throw new Error(
            `Notebook input registration no longer matches its immutable Version: ${input.inputFileVersionId}`
          )
        }
        return { ...validation.input, association: 'turn-attached' as const }
      })
    )
    return new NotebookInputRunLease(inputs, (input) =>
      this.options.inputAuthority.resolveContent(input)
    )
  }

  clearSession(appSessionId: string): void {
    for (const key of this.turns.keys()) {
      const parsed = JSON.parse(key) as [string, string, string]
      if (parsed[1] === appSessionId) this.turns.delete(key)
    }
  }

  async resolvePreview(
    request: ResolveNotebookInputPreviewRequest
  ): Promise<NotebookInputPreviewTarget> {
    const input = await this.resolveVersion(request)
    const absolutePath = await this.options.inputAuthority.resolveContent(input)
    return {
      sourceKind: input.sourceKind,
      inputFileVersionId: input.inputFileVersionId,
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      checksum: input.checksum,
      absolutePath
    }
  }

  async resolvePreviewKey(key: string): Promise<NotebookInputPreviewTarget> {
    return this.resolvePreview(parseNotebookInputPreviewKey(key))
  }

  async readPreview(request: ReadArtifactPreviewRequest): Promise<ArtifactPreviewResult> {
    const target = await this.resolvePreviewKey(request.path)
    return readBoundedManagedFilePreview(
      target.absolutePath,
      request,
      'Invalid Notebook input preview encoding.'
    )
  }

  private async resolveVersion(
    request: Parameters<ImmutableInputAuthority['resolveVersion']>[0]
  ): Promise<NotebookRunInputFile> {
    const input = await this.options.inputAuthority.resolveVersion(request)
    if (input) return input
    const label = request.sourceKind === 'upload-version' ? 'Upload' : 'Artifact'
    throw new Error(
      `${label} Version is unavailable in this Project: ${request.inputFileVersionId}`
    )
  }
}

export { NotebookInputRegistry }
export type {
  GetNotebookTurnInputsRequest,
  NotebookInputRunLease,
  NotebookInputPreviewTarget,
  NotebookInputRegistryOptions,
  OpenNotebookInputRunRequest,
  RegisterNotebookTurnInputsRequest,
  ResolveNotebookInputRunRequest,
  ResolveNotebookInputPreviewRequest
}
