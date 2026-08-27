import type { NotebookRunInputFile } from '../shared/notebook'
import {
  ManagedFileVersionError,
  type ManagedFileReadLease,
  type ManagedFileVersionService
} from './managed-file-versions/service'

type ResolveImmutableInputVersionRequest = {
  projectId: string
  sourceKind: NotebookRunInputFile['sourceKind']
  inputFileVersionId: string
  expectedSourceFileId?: string
}

type ImmutableInputAuthorityOptions = {
  managedFileVersions: Pick<ManagedFileVersionService, 'openVersion'>
}

type ImmutableInputVersionValidation =
  | { state: 'available'; input: NotebookRunInputFile }
  | { state: 'project-mismatch' | 'unavailable' | 'identity-mismatch' }

type ImmutableInputContentLease = Pick<
  ManagedFileReadLease,
  'path' | 'readRange' | 'verifyUnchanged' | 'close'
>

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
  ResolveImmutableInputVersionRequest
}
