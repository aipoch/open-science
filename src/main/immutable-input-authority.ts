import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

import type { NotebookRunInputFile } from '../shared/notebook'
import { ManagedFileVersionError } from './managed-file-versions/error'
import type {
  ManagedFileReadLease,
  ManagedFileVersionService
} from './managed-file-versions/service'
import { getNotebookInputRoot } from './notebook/input-staging'

type ResolveImmutableInputVersionRequest = {
  projectId: string
  sourceKind: NotebookRunInputFile['sourceKind']
  inputFileVersionId: string
  expectedSourceFileId?: string
}

type StageImmutableInputVersionRequest = ResolveImmutableInputVersionRequest & {
  targetSessionId: string
}

type StageLatestImmutableInputRequest = {
  projectId: string
  targetSessionId: string
  sourceKind: NotebookRunInputFile['sourceKind']
  expectedSourceFileId: string
}

type ImmutableInputAuthorityOptions = {
  storageRoot: string
  managedFileVersions: Pick<ManagedFileVersionService, 'openVersion'> &
    Partial<Pick<ManagedFileVersionService, 'openLatest'>>
}

type ImmutableInputVersionValidation =
  | { state: 'available'; input: NotebookRunInputFile }
  | { state: 'project-mismatch' | 'unavailable' | 'identity-mismatch' }

type ImmutableInputContentLease = Pick<
  ManagedFileReadLease,
  | 'path'
  | 'size'
  | 'versionToken'
  | 'snapshot'
  | 'read'
  | 'readRange'
  | 'copyTo'
  | 'assertCanCopyTo'
  | 'verifyUnchanged'
  | 'close'
>

type VerifiedContent = {
  fingerprint: string
  checksum: string
}

const fileFingerprint = (file: Awaited<ReturnType<typeof stat>>): string =>
  [file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs].join(':')

const matchesVersionIdentity = (
  current: NotebookRunInputFile,
  expected: NotebookRunInputFile
): boolean =>
  current.sourceFileId === expected.sourceFileId &&
  current.sourceProjectId === expected.sourceProjectId &&
  current.sourceSessionId === expected.sourceSessionId &&
  current.sourceVersionNumber === expected.sourceVersionNumber &&
  current.storageKey === expected.storageKey &&
  current.checksum === expected.checksum &&
  current.sizeBytes === expected.sizeBytes

const isUnavailableVersionError = (error: unknown): boolean =>
  error instanceof ManagedFileVersionError &&
  (error.code === 'FILE_NOT_FOUND' ||
    error.code === 'FILE_DELETED' ||
    error.code === 'VERSION_NOT_FOUND' ||
    error.code === 'VERSION_NOT_IN_FILE')

const sourceFor = (sourceKind: NotebookRunInputFile['sourceKind']): 'artifact' | 'upload' =>
  sourceKind === 'upload-version' ? 'upload' : 'artifact'

const toNotebookInput = (
  sourceKind: NotebookRunInputFile['sourceKind'],
  lease: ManagedFileReadLease
): NotebookRunInputFile => ({
  inputFileVersionId: lease.version.id,
  sourceKind,
  sourceFileId: lease.logicalFile.id,
  sourceVersionNumber: lease.version.versionNumber,
  sourceCreatedAt: lease.version.createdAt.toISOString(),
  sourceProjectId: lease.logicalFile.projectId,
  sourceSessionId: lease.logicalFile.sessionId,
  filename: lease.logicalFile.displayName,
  ...(lease.version.contentType ? { contentType: lease.version.contentType } : {}),
  sizeBytes: Number(lease.version.sizeBytes),
  checksum: lease.version.checksum,
  storageKey: lease.version.contentStorageKey,
  association: 'turn-attached'
})

class ImmutableInputAuthority {
  private readonly verifiedContent = new Map<string, VerifiedContent>()
  private readonly staging = new Map<string, Promise<string>>()

  constructor(private readonly options: ImmutableInputAuthorityOptions) {}

  async resolveVersion(
    request: ResolveImmutableInputVersionRequest
  ): Promise<NotebookRunInputFile | undefined> {
    const lease = await this.openRequestedVersion(request)
    if (!lease) return undefined
    try {
      await lease.verifyUnchanged()
      return toNotebookInput(request.sourceKind, lease)
    } finally {
      await lease.close()
    }
  }

  async validateVersion(
    projectId: string,
    input: NotebookRunInputFile
  ): Promise<ImmutableInputVersionValidation> {
    if (input.sourceProjectId !== projectId) return { state: 'project-mismatch' }
    const lease = await this.openRequestedVersion({
      projectId,
      sourceKind: input.sourceKind,
      inputFileVersionId: input.inputFileVersionId,
      expectedSourceFileId: input.sourceFileId
    })
    if (!lease) return { state: 'unavailable' }
    try {
      const current = toNotebookInput(input.sourceKind, lease)
      if (!matchesVersionIdentity(current, input)) return { state: 'identity-mismatch' }
      await lease.verifyUnchanged()
      return { state: 'available', input: current }
    } finally {
      await lease.close()
    }
  }

  async openContent(input: NotebookRunInputFile): Promise<ImmutableInputContentLease> {
    const lease = await this.openRequestedVersion({
      projectId: input.sourceProjectId,
      sourceKind: input.sourceKind,
      inputFileVersionId: input.inputFileVersionId,
      expectedSourceFileId: input.sourceFileId
    })
    if (!lease) throw new Error('Notebook input Version is unavailable.')
    try {
      if (!matchesVersionIdentity(toNotebookInput(input.sourceKind, lease), input)) {
        throw new Error('Notebook input identity no longer matches its immutable Version.')
      }
      await lease.verifyUnchanged()
      return lease
    } catch (error) {
      await lease.close().catch(() => undefined)
      throw error
    }
  }

  async stageVersion(request: StageImmutableInputVersionRequest): Promise<string> {
    const target = this.stagingTarget(
      request.projectId,
      request.targetSessionId,
      request.sourceKind,
      request.inputFileVersionId
    )
    return this.runStaging(target.path, async () => {
      const lease = await this.openRequestedVersion(request)
      if (!lease) {
        const label = request.sourceKind === 'upload-version' ? 'Upload' : 'Artifact'
        throw new Error(
          `${label} Version is unavailable in this Project: ${request.inputFileVersionId}`
        )
      }
      return this.stageLease(toNotebookInput(request.sourceKind, lease), lease, target)
    })
  }

  async stageLatest(request: StageLatestImmutableInputRequest): Promise<string> {
    const openLatest = this.options.managedFileVersions.openLatest
    if (!openLatest) throw new Error('Latest immutable input authority is not configured.')
    const lease = await openLatest.call(this.options.managedFileVersions, {
      source: sourceFor(request.sourceKind),
      projectId: request.projectId,
      fileId: request.expectedSourceFileId
    })
    const input = toNotebookInput(request.sourceKind, lease)
    const target = this.stagingTarget(
      request.projectId,
      request.targetSessionId,
      request.sourceKind,
      input.inputFileVersionId
    )
    const active = this.staging.get(target.path)
    if (active) {
      await lease.close()
      return active
    }
    return this.runStaging(target.path, () => this.stageLease(input, lease, target))
  }

  async stageContent(input: NotebookRunInputFile, targetSessionId: string): Promise<string> {
    const target = this.stagingTarget(
      input.sourceProjectId,
      targetSessionId,
      input.sourceKind,
      input.inputFileVersionId
    )
    return this.runStaging(target.path, async () => {
      const lease = await this.openContent(input)
      return this.stageLease(input, lease, target)
    })
  }

  private async runStaging(target: string, start: () => Promise<string>): Promise<string> {
    const active = this.staging.get(target)
    if (active) return active
    const operation = start()
    this.staging.set(target, operation)
    return operation.finally(() => {
      if (this.staging.get(target) === operation) this.staging.delete(target)
    })
  }

  private async stageLease(
    input: NotebookRunInputFile,
    lease: ImmutableInputContentLease,
    target: { inputRoot: string; versionKey: string; path: string }
  ): Promise<string> {
    try {
      return await this.stageContentExclusive(input, lease, target.inputRoot, target.versionKey)
    } finally {
      await lease.close()
    }
  }

  private stagingTarget(
    projectId: string,
    targetSessionId: string,
    sourceKind: NotebookRunInputFile['sourceKind'],
    inputFileVersionId: string
  ): { inputRoot: string; versionKey: string; path: string } {
    const inputRoot = getNotebookInputRoot(this.options.storageRoot, projectId, targetSessionId)
    const versionKey = createHash('sha256')
      .update(`${sourceKind}\0${inputFileVersionId}`)
      .digest('hex')
    return {
      inputRoot,
      versionKey,
      path: join(inputRoot, sourceKind, versionKey, 'content')
    }
  }

  private async stageContentExclusive(
    input: NotebookRunInputFile,
    lease: ImmutableInputContentLease,
    inputRoot: string,
    versionKey: string
  ): Promise<string> {
    await mkdir(inputRoot, { recursive: true })
    const resolvedRoot = await realpath(inputRoot)
    const kindDirectory = join(resolvedRoot, input.sourceKind)
    await mkdir(kindDirectory, { recursive: true })
    const resolvedKindDirectory = await realpath(kindDirectory)
    this.assertInside(resolvedRoot, resolvedKindDirectory)
    const targetDirectory = join(resolvedKindDirectory, versionKey)
    await mkdir(targetDirectory, { recursive: true })
    const resolvedTargetDirectory = await realpath(targetDirectory)
    this.assertInside(resolvedKindDirectory, resolvedTargetDirectory)
    const target = join(resolvedTargetDirectory, 'content')
    try {
      if ((await lstat(target)).isSymbolicLink()) {
        throw new Error('Notebook input staging target must not be a symbolic link.')
      }
      await this.verifyContent(target, input)
      await lease.verifyUnchanged()
      return target
    } catch {
      // A missing or corrupt derived copy is safe to replace from the open immutable lease.
    }

    const temporary = join(resolvedTargetDirectory, `.content-${randomUUID()}.tmp`)
    try {
      await lease.copyTo(temporary, { exclusive: true })
      await this.verifyContent(temporary, input)
      if (process.platform !== 'win32') await chmod(temporary, 0o444)
      await rm(target, { force: true })
      await rename(temporary, target)
      this.verifiedContent.delete(target)
      await this.verifyContent(target, input)
      await lease.verifyUnchanged()
      return target
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private assertInside(parent: string, child: string): void {
    const relativePath = child.slice(parent.length)
    if (child === parent || !relativePath.startsWith(sep)) {
      throw new Error('Notebook input staging path escapes its Session root.')
    }
  }

  private async verifyContent(path: string, input: NotebookRunInputFile): Promise<void> {
    const file = await stat(path)
    if (!file.isFile() || file.size !== input.sizeBytes) {
      throw new Error(
        'Notebook input content is missing or no longer matches its immutable metadata.'
      )
    }
    const fingerprint = fileFingerprint(file)
    const cached = this.verifiedContent.get(path)
    if (cached?.fingerprint === fingerprint && cached.checksum === input.checksum) return

    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    if (hash.digest('hex') !== input.checksum) {
      throw new Error('Notebook input content checksum does not match its immutable metadata.')
    }
    const afterRead = await stat(path)
    if (fileFingerprint(afterRead) !== fingerprint) {
      throw new Error('Notebook input content changed while its checksum was being validated.')
    }
    this.verifiedContent.set(path, { fingerprint, checksum: input.checksum })
  }

  private async openRequestedVersion(
    request: ResolveImmutableInputVersionRequest
  ): Promise<ManagedFileReadLease | undefined> {
    if (!request.expectedSourceFileId) return undefined
    try {
      return await this.options.managedFileVersions.openVersion(
        {
          source: sourceFor(request.sourceKind),
          projectId: request.projectId,
          fileId: request.expectedSourceFileId
        },
        request.inputFileVersionId
      )
    } catch (error) {
      if (isUnavailableVersionError(error)) return undefined
      throw error
    }
  }
}

export { ImmutableInputAuthority }
export type {
  ImmutableInputAuthorityOptions,
  ImmutableInputContentLease,
  ImmutableInputVersionValidation,
  ResolveImmutableInputVersionRequest,
  StageLatestImmutableInputRequest,
  StageImmutableInputVersionRequest
}
