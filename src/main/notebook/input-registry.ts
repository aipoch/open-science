import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'

import type { PrismaClient } from '@prisma/client'

import type { FileReference } from '../../shared/artifacts'
import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import { parseNotebookInputPreviewKey, type NotebookRunInputFile } from '../../shared/notebook'
import type { UploadedAttachment } from '../../shared/uploads'
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

type OpenNotebookInputRunRequest = GetNotebookTurnInputsRequest

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
  storageRoot: string
  getClient: () => Promise<PrismaClient>
}

type RegisteredTurn = {
  fingerprint: string
  inputs: NotebookRunInputFile[]
}

type VerifiedContent = {
  fingerprint: string
  checksum: string
}

const turnKey = (request: GetNotebookTurnInputsRequest): string =>
  JSON.stringify([request.projectId, request.appSessionId, request.promptMessageId])

const versionKey = (input: NotebookRunInputFile): string =>
  `${input.sourceKind}\0${input.inputFileVersionId}`

const resolveStorageKey = (storageRoot: string, key: string): string => {
  if (!key || isAbsolute(key) || key.includes('\\')) {
    throw new Error('Invalid Notebook input storage key.')
  }
  const absolutePath = resolve(storageRoot, ...key.split('/'))
  const relativePath = absolutePath.slice(resolve(storageRoot).length)
  if (
    absolutePath === resolve(storageRoot) ||
    (!relativePath.startsWith(sep) && relativePath !== '') ||
    key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('Notebook input storage key escapes managed storage.')
  }
  return absolutePath
}

const assertAvailableContent = async (
  storageRoot: string,
  storageKey: string,
  expectedSize: number,
  expectedChecksum: string,
  verifiedContent: Map<string, VerifiedContent>
): Promise<string> => {
  const absolutePath = resolveStorageKey(storageRoot, storageKey)
  const [resolvedRoot, resolvedPath] = await Promise.all([
    realpath(storageRoot),
    realpath(absolutePath)
  ])
  const resolvedRelativePath = resolvedPath.slice(resolvedRoot.length)
  if (
    resolvedPath === resolvedRoot ||
    (!resolvedRelativePath.startsWith(sep) && resolvedRelativePath !== '')
  ) {
    throw new Error('Notebook input content escapes managed storage.')
  }
  const file = await stat(resolvedPath)
  if (!file.isFile() || file.size !== expectedSize) {
    throw new Error(
      'Notebook input content is missing or no longer matches its immutable metadata.'
    )
  }
  const fingerprint = [file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs].join(':')
  const cached = verifiedContent.get(storageKey)
  if (cached?.fingerprint === fingerprint && cached.checksum === expectedChecksum) {
    return resolvedPath
  }

  const hash = createHash('sha256')
  for await (const chunk of createReadStream(resolvedPath)) hash.update(chunk)
  if (hash.digest('hex') !== expectedChecksum) {
    throw new Error('Notebook input content checksum does not match its immutable metadata.')
  }
  const afterRead = await stat(resolvedPath)
  const afterReadFingerprint = [
    afterRead.dev,
    afterRead.ino,
    afterRead.size,
    afterRead.mtimeMs,
    afterRead.ctimeMs
  ].join(':')
  if (afterReadFingerprint !== fingerprint) {
    throw new Error('Notebook input content changed while its checksum was being validated.')
  }
  verifiedContent.set(storageKey, { fingerprint, checksum: expectedChecksum })
  return resolvedPath
}

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
  private readonly verifiedContent = new Map<string, VerifiedContent>()

  constructor(private readonly options: NotebookInputRegistryOptions) {}

  async registerTurn(request: RegisterNotebookTurnInputsRequest): Promise<void> {
    const inputs: NotebookRunInputFile[] = []
    for (const upload of request.uploads) {
      if (!upload.versionId) {
        throw new Error(`Upload input has no immutable Version identity: ${upload.originalName}`)
      }
      inputs.push(
        await this.resolveVersion(request.projectId, 'upload-version', upload.versionId, upload.id)
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
        await this.resolveVersion(
          request.projectId,
          reference.source === 'upload' ? 'upload-version' : 'artifact-version',
          reference.versionId
        )
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
    const inputs = await Promise.all(
      registered.map(async (input) => {
        const current = await this.resolveVersion(
          request.projectId,
          input.sourceKind,
          input.inputFileVersionId,
          input.sourceFileId
        )
        if (
          current.storageKey !== input.storageKey ||
          current.checksum !== input.checksum ||
          current.sizeBytes !== input.sizeBytes ||
          current.sourceSessionId !== input.sourceSessionId ||
          current.sourceVersionNumber !== input.sourceVersionNumber
        ) {
          throw new Error(
            `Notebook input registration no longer matches its immutable Version: ${input.inputFileVersionId}`
          )
        }
        return { ...current, association: 'turn-attached' as const }
      })
    )
    return new NotebookInputRunLease(inputs, (input) =>
      assertAvailableContent(
        this.options.storageRoot,
        input.storageKey,
        input.sizeBytes,
        input.checksum,
        this.verifiedContent
      )
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
    const input = await this.resolveVersion(
      request.projectId,
      request.sourceKind,
      request.inputFileVersionId
    )
    const absolutePath = await assertAvailableContent(
      this.options.storageRoot,
      input.storageKey,
      input.sizeBytes,
      input.checksum,
      this.verifiedContent
    )
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
    projectId: string,
    sourceKind: NotebookRunInputFile['sourceKind'],
    inputFileVersionId: string,
    expectedSourceFileId?: string
  ): Promise<NotebookRunInputFile> {
    const client = await this.options.getClient()
    if (sourceKind === 'upload-version') {
      const version = await client.uploadVersion.findFirst({
        where: {
          id: inputFileVersionId,
          state: 'ready',
          uploadFile: { is: { projectId } }
        },
        include: { uploadFile: true }
      })
      if (!version || (expectedSourceFileId && version.uploadFileId !== expectedSourceFileId)) {
        throw new Error(`Upload Version is unavailable in this Project: ${inputFileVersionId}`)
      }
      const sizeBytes = Number(version.sizeBytes)
      await assertAvailableContent(
        this.options.storageRoot,
        version.contentStorageKey,
        sizeBytes,
        version.checksum,
        this.verifiedContent
      )
      return {
        inputFileVersionId: version.id,
        sourceKind,
        sourceFileId: version.uploadFileId,
        sourceVersionNumber: version.versionNumber,
        ...(version.createdAt ? { sourceCreatedAt: version.createdAt.toISOString() } : {}),
        sourceProjectId: version.uploadFile.projectId,
        sourceSessionId: version.uploadFile.sessionId,
        filename: version.originalFilename || version.filename,
        ...(version.contentType ? { contentType: version.contentType } : {}),
        sizeBytes,
        checksum: version.checksum,
        storageKey: version.contentStorageKey,
        association: 'turn-attached'
      }
    }

    const version = await client.artifactVersion.findFirst({
      where: {
        id: inputFileVersionId,
        state: 'finalized',
        artifact: { is: { projectId } }
      },
      include: { artifact: true }
    })
    if (!version || (expectedSourceFileId && version.artifactId !== expectedSourceFileId)) {
      throw new Error(`Artifact Version is unavailable in this Project: ${inputFileVersionId}`)
    }
    const sizeBytes = Number(version.sizeBytes)
    await assertAvailableContent(
      this.options.storageRoot,
      version.contentStorageKey,
      sizeBytes,
      version.checksum,
      this.verifiedContent
    )
    return {
      inputFileVersionId: version.id,
      sourceKind,
      sourceFileId: version.artifactId,
      sourceVersionNumber: version.versionNumber,
      sourceCreatedAt: version.createdAt.toISOString(),
      sourceProjectId: version.artifact.projectId,
      sourceSessionId: version.artifact.sessionId,
      filename: version.artifact.filename,
      ...(version.contentType ? { contentType: version.contentType } : {}),
      sizeBytes,
      checksum: version.checksum,
      storageKey: version.contentStorageKey,
      association: 'turn-attached'
    }
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
