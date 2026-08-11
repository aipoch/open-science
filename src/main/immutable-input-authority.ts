import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'

import type { PrismaClient } from '@prisma/client'

import type { NotebookRunInputFile } from '../shared/notebook'

type ResolveImmutableInputVersionRequest = {
  projectId: string
  sourceKind: NotebookRunInputFile['sourceKind']
  inputFileVersionId: string
  expectedSourceFileId?: string
}

type ImmutableInputAuthorityOptions = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
}

type ImmutableInputVersionValidation =
  | { state: 'available'; input: NotebookRunInputFile }
  | { state: 'project-mismatch' | 'unavailable' | 'identity-mismatch' }

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

class ImmutableInputAuthority {
  private readonly verifiedContent = new Map<string, VerifiedContent>()

  constructor(private readonly options: ImmutableInputAuthorityOptions) {}

  async resolveVersion(
    request: ResolveImmutableInputVersionRequest
  ): Promise<NotebookRunInputFile | undefined> {
    const input = await this.loadVersion(request)
    if (!input) return undefined
    await this.resolveContent(input)
    return input
  }

  async validateVersion(
    projectId: string,
    input: NotebookRunInputFile
  ): Promise<ImmutableInputVersionValidation> {
    if (input.sourceProjectId !== projectId) {
      return { state: 'project-mismatch' }
    }
    const current = await this.loadVersion({
      projectId,
      sourceKind: input.sourceKind,
      inputFileVersionId: input.inputFileVersionId,
      expectedSourceFileId: input.sourceFileId
    })
    if (!current) return { state: 'unavailable' }
    if (!matchesVersionIdentity(current, input)) return { state: 'identity-mismatch' }
    await this.resolveContent(current)
    return { state: 'available', input: current }
  }

  async resolveContent(input: NotebookRunInputFile): Promise<string> {
    const storageRoot = resolve(this.options.storageRoot)
    const segments = input.storageKey.split('/')
    if (
      !input.storageKey ||
      isAbsolute(input.storageKey) ||
      input.storageKey.includes('\\') ||
      segments.some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      throw new Error('Invalid Notebook input storage key.')
    }
    const absolutePath = resolve(storageRoot, ...segments)
    const storageRelativePath = absolutePath.slice(storageRoot.length)
    if (
      absolutePath === storageRoot ||
      (!storageRelativePath.startsWith(sep) && storageRelativePath !== '')
    ) {
      throw new Error('Notebook input storage key escapes managed storage.')
    }

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
    if (!file.isFile() || file.size !== input.sizeBytes) {
      throw new Error(
        'Notebook input content is missing or no longer matches its immutable metadata.'
      )
    }
    const fingerprint = fileFingerprint(file)
    const cached = this.verifiedContent.get(input.storageKey)
    if (cached?.fingerprint === fingerprint && cached.checksum === input.checksum) {
      return resolvedPath
    }

    const hash = createHash('sha256')
    for await (const chunk of createReadStream(resolvedPath)) hash.update(chunk)
    if (hash.digest('hex') !== input.checksum) {
      throw new Error('Notebook input content checksum does not match its immutable metadata.')
    }
    const afterRead = await stat(resolvedPath)
    if (fileFingerprint(afterRead) !== fingerprint) {
      throw new Error('Notebook input content changed while its checksum was being validated.')
    }
    this.verifiedContent.set(input.storageKey, { fingerprint, checksum: input.checksum })
    return resolvedPath
  }

  private async loadVersion(
    request: ResolveImmutableInputVersionRequest
  ): Promise<NotebookRunInputFile | undefined> {
    const client = await this.options.getClient()
    if (request.sourceKind === 'upload-version') {
      const version = await client.uploadVersion.findFirst({
        where: {
          id: request.inputFileVersionId,
          state: 'ready',
          uploadFile: { is: { projectId: request.projectId } }
        },
        include: { uploadFile: true }
      })
      if (
        !version ||
        (request.expectedSourceFileId && version.uploadFileId !== request.expectedSourceFileId)
      ) {
        return undefined
      }
      return {
        inputFileVersionId: version.id,
        sourceKind: request.sourceKind,
        sourceFileId: version.uploadFileId,
        sourceVersionNumber: version.versionNumber,
        ...(version.createdAt ? { sourceCreatedAt: version.createdAt.toISOString() } : {}),
        sourceProjectId: version.uploadFile.projectId,
        sourceSessionId: version.uploadFile.sessionId,
        filename: version.originalFilename || version.filename,
        ...(version.contentType ? { contentType: version.contentType } : {}),
        sizeBytes: Number(version.sizeBytes),
        checksum: version.checksum,
        storageKey: version.contentStorageKey,
        association: 'turn-attached'
      }
    }

    const version = await client.artifactVersion.findFirst({
      where: {
        id: request.inputFileVersionId,
        state: 'finalized',
        artifact: { is: { projectId: request.projectId } }
      },
      include: { artifact: true }
    })
    if (
      !version ||
      (request.expectedSourceFileId && version.artifactId !== request.expectedSourceFileId)
    ) {
      return undefined
    }
    return {
      inputFileVersionId: version.id,
      sourceKind: request.sourceKind,
      sourceFileId: version.artifactId,
      sourceVersionNumber: version.versionNumber,
      sourceCreatedAt: version.createdAt.toISOString(),
      sourceProjectId: version.artifact.projectId,
      sourceSessionId: version.artifact.sessionId,
      filename: version.artifact.filename,
      ...(version.contentType ? { contentType: version.contentType } : {}),
      sizeBytes: Number(version.sizeBytes),
      checksum: version.checksum,
      storageKey: version.contentStorageKey,
      association: 'turn-attached'
    }
  }
}

export { ImmutableInputAuthority }
export type {
  ImmutableInputAuthorityOptions,
  ImmutableInputVersionValidation,
  ResolveImmutableInputVersionRequest
}
