import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

import type { PrismaClient } from '@prisma/client'

import type { NotebookRunInputFile } from '../shared/notebook'
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
  private readonly staging = new Map<string, Promise<string>>()

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

    await this.verifyContent(resolvedPath, input)
    return resolvedPath
  }

  async stageVersion(request: StageImmutableInputVersionRequest): Promise<string> {
    const input = await this.loadVersion(request)
    if (!input) {
      const label = request.sourceKind === 'upload-version' ? 'Upload' : 'Artifact'
      throw new Error(
        `${label} Version is unavailable in this Project: ${request.inputFileVersionId}`
      )
    }
    return this.stageContent(input, request.targetSessionId)
  }

  async stageContent(input: NotebookRunInputFile, targetSessionId: string): Promise<string> {
    const inputRoot = getNotebookInputRoot(
      this.options.storageRoot,
      input.sourceProjectId,
      targetSessionId
    )
    const versionKey = createHash('sha256')
      .update(`${input.sourceKind}\0${input.inputFileVersionId}`)
      .digest('hex')
    const targetDirectory = join(inputRoot, input.sourceKind, versionKey)
    const target = join(targetDirectory, 'content')
    const active = this.staging.get(target)
    if (active) return active

    const operation = this.stageContentExclusive(input, inputRoot, versionKey)
    this.staging.set(target, operation)
    return operation.finally(() => {
      if (this.staging.get(target) === operation) this.staging.delete(target)
    })
  }

  private async stageContentExclusive(
    input: NotebookRunInputFile,
    inputRoot: string,
    versionKey: string
  ): Promise<string> {
    const source = await this.resolveContent(input)
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
      await this.verifyContent(target, input)
      return target
    } catch {
      // A missing or corrupt derived copy is safe to replace from the verified Version authority.
    }

    const temporary = join(resolvedTargetDirectory, `.content-${randomUUID()}.tmp`)
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL)
      await this.verifyContent(temporary, input)
      if (process.platform !== 'win32') await chmod(temporary, 0o444)
      await rm(target, { force: true })
      await rename(temporary, target)
      this.verifiedContent.delete(target)
      await this.verifyContent(target, input)
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
    if (cached?.fingerprint === fingerprint && cached.checksum === input.checksum) {
      return
    }

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
  ResolveImmutableInputVersionRequest,
  StageImmutableInputVersionRequest
}
