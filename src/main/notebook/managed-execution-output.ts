import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type {
  ArtifactVersionFile,
  ArtifactWriteSourceScope
} from '../../shared/artifact-provenance'
import type { NotebookRunProvenanceContext, NotebookRunRecord } from '../../shared/notebook'
import { digestFileWithinBudget } from '../bounded-file-io'
import { LOCAL_RESOURCE_BUDGETS } from '../resource-budget'
import {
  freezeManagedOutputWriteAttempt,
  managedOutputWriteAttemptSchema,
  type ManagedOutputPublication,
  type ManagedOutputWriteAttempt
} from './managed-output-publication'
import {
  resolveManagedOutputRecoveryAuthority,
  type ManagedOutputRecoveryAuthority,
  type ManagedOutputRecoveryProof
} from './managed-output-recovery'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { createNotebookArtifactSourceScopeProvider } from './artifact-source-scope'
import {
  resolveManagedOutputAuthority,
  type ManagedOutputAuthority
} from './managed-output-authority'
import type { NotebookRunRepository } from './repository'

export type ManagedExecutionOutput = {
  filename: string
  contentType?: string
  source:
    | { kind: 'inline'; content: string; encoding?: 'base64' }
    | { kind: 'localPath'; path: string; root?: 'workspace' | 'notebook' }
    | { kind: 'managedOutput'; path: string; authority: ManagedOutputAuthority }
  producerRunId?: string
  publication?: ManagedOutputPublication
}
/** Main-only inline byte limit. Public execution requests do not expose this writer capability. */
export const MAX_MANAGED_INLINE_BINARY_BYTES = 16 * 1024 * 1024
export const MAX_MANAGED_INLINE_BASE64_CHARACTERS =
  Math.ceil(MAX_MANAGED_INLINE_BINARY_BYTES / 3) * 4

/** Standard, padded, canonical base64 only: no whitespace, URL alphabet or ignored trailing bits.
 * Validate before allocating decoded bytes; Buffer.from alone silently accepts malformed input. */
export function isCanonicalManagedInlineBase64(content: string): boolean {
  if (content.length > MAX_MANAGED_INLINE_BASE64_CHARACTERS || content.length % 4 !== 0)
    return false
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0
  const body = content.slice(0, content.length - padding)
  if (
    /[^A-Za-z0-9+/]/.test(body) ||
    (content.length / 4) * 3 - padding > MAX_MANAGED_INLINE_BINARY_BYTES
  )
    return false
  if (padding) {
    const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(
      body.at(-1) ?? ''
    )
    if (last < 0 || (last & (padding === 2 ? 15 : 3)) !== 0) return false
  }
  return true
}

export type ManagedExecutionRecoveryOutput = Omit<
  ManagedExecutionOutput,
  'source' | 'producerRunId' | 'publication'
> & {
  source: Extract<ManagedExecutionOutput['source'], { kind: 'managedOutput' }>
  producerRunId: string
  recoveryAuthority: ManagedOutputRecoveryAuthority
  publication: ManagedOutputPublication & { previousAttempts: readonly ManagedOutputWriteAttempt[] }
}
export type ManagedExecutionRecoveredOutput = { artifact: ArtifactVersionFile; reused: boolean }

export type ManagedExecutionProvenance = Required<
  Pick<
    NotebookRunProvenanceContext,
    'rootFrameId' | 'agentFrameId' | 'messageBranchId' | 'runtimeSegmentId' | 'promptMessageId'
  >
>
export type ManagedExecutionOutputScope = {
  projectId: string
  sessionId: string
  operationId: string
  workspaceCwd: string
  artifactRunId: string
  artifactStorageSessionId: string
  writeNamespace: string
  provenanceContext: ManagedExecutionProvenance
  messageAncestry: readonly string[]
}
type Dependencies = {
  dataRoot: string
  artifacts: Pick<ArtifactProvenanceRepository, 'saveVersion' | 'replayVersion'>
  notebooks: Pick<NotebookRunRepository, 'readSessionDocuments'>
}

/** Common output validation for an externally admitted request or an already running Agent turn. */
export function createManagedExecutionOutputWriter(
  dependencies: Dependencies,
  scope: ManagedExecutionOutputScope,
  signal: AbortSignal,
  observers: {
    onRun?(runId: string): Promise<void>
    onArtifact?(artifact: ArtifactVersionFile): Promise<void>
  } = {}
): {
  notebookDataDir: string
  recordRun(runId: string): Promise<void>
  saveOutput(output: ManagedExecutionOutput): Promise<ArtifactVersionFile>
  recoverOutput(output: ManagedExecutionRecoveryOutput): Promise<ManagedExecutionRecoveredOutput>
} {
  const source = createNotebookArtifactSourceScopeProvider(dependencies.dataRoot)({
    projectId: scope.projectId,
    appSessionId: scope.sessionId,
    ...scope.provenanceContext
  })
  const sourceScope: ArtifactWriteSourceScope = {
    allowedImportRoots: [
      source.notebookSessionRoot,
      ...(scope.workspaceCwd ? [scope.workspaceCwd] : [])
    ],
    workspaceCwd: scope.workspaceCwd,
    notebookDataDir: source.notebookDataDir,
    notebookSessionRoot: source.notebookSessionRoot
  }
  const recorded = new Set<string>()
  const findRun = async (
    runId: string,
    expected: ManagedExecutionProvenance = scope.provenanceContext
  ): Promise<NotebookRunRecord> => {
    const runs = (
      await dependencies.notebooks.readSessionDocuments(scope.projectId, scope.sessionId)
    ).flatMap(({ runs }) => runs)
    const matching = runs.filter((item) => item.runId === runId)
    const run = matching.length === 1 ? matching[0] : undefined
    if (
      !run ||
      Object.entries(expected).some(
        ([key, value]) => run[key as keyof ManagedExecutionProvenance] !== value
      )
    )
      throw new Error('Notebook Run does not belong to this Session operation.')
    return run
  }
  const save = async (
    output: ManagedExecutionOutput,
    recovery?: ManagedOutputRecoveryProof
  ): Promise<ArtifactVersionFile> => {
    output = {
      ...output,
      source: { ...output.source },
      ...(output.publication
        ? { publication: { beforeWrite: output.publication.beforeWrite.bind(output.publication) } }
        : {})
    }
    signal.throwIfAborted()
    let producer: NotebookRunRecord | undefined
    if (output.producerRunId) {
      producer = await findRun(output.producerRunId, recovery?.producerProvenance)
      if (
        (!recovery && !recorded.has(producer.runId)) ||
        producer.status === 'queued' ||
        producer.status === 'running'
      )
        throw new Error('Artifact producer must be a terminal recorded Run of this operation.')
    }
    let writeScope = sourceScope
    let writeSignal = recovery ? AbortSignal.any([signal, recovery.signal]) : signal
    let artifactSource:
      { kind: 'inline'; content: string; encoding: 'base64' } | { kind: 'localPath'; path: string }
    if (output.source.kind === 'inline') {
      if (output.source.encoding !== undefined && output.source.encoding !== 'base64')
        throw new Error('Unsupported inline Artifact encoding.')
      if (
        output.source.encoding === 'base64' &&
        !isCanonicalManagedInlineBase64(output.source.content)
      )
        throw new Error('Inline Artifact binary content must be canonical base64 within 16 MiB.')
      artifactSource = {
        kind: 'inline',
        content:
          output.source.encoding === 'base64'
            ? output.source.content
            : Buffer.from(output.source.content, 'utf8').toString('base64'),
        encoding: 'base64'
      }
    } else if (output.source.kind === 'managedOutput') {
      const managed = await resolveManagedOutputAuthority(
        output.source.authority,
        scope,
        output.source.path
      )
      artifactSource = { kind: 'localPath', path: managed.path }
      writeScope = {
        ...sourceScope,
        allowedImportRoots: [...(sourceScope.allowedImportRoots ?? []), managed.root]
      }
      writeSignal = AbortSignal.any([writeSignal, managed.signal])
    } else {
      const path = output.source.path
      if (
        !path ||
        isAbsolute(path) ||
        path.includes('\\') ||
        path.includes(':') ||
        [...path].some((character) => character.charCodeAt(0) < 32) ||
        path.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new Error('Artifact output must use a managed relative path.')
      const root = output.source.root === 'workspace' ? scope.workspaceCwd : source.notebookDataDir
      if (!root) throw new Error('Session has no managed output root.')
      const [actualRoot, actualFile] = await Promise.all([
        realpath(root),
        realpath(join(root, path))
      ])
      const rel = relative(actualRoot, actualFile)
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error('Artifact output escapes its managed root.')
      artifactSource = { kind: 'localPath', path: actualFile }
    }
    const writeIdentity = createHash('sha256')
      .update(JSON.stringify([scope.operationId, scope.writeNamespace, output.filename]))
      .digest('hex')
    const request = {
      projectId: scope.projectId,
      appSessionId: scope.sessionId,
      artifactStorageSessionId: scope.artifactStorageSessionId,
      artifactRunId: scope.artifactRunId,
      writeOperationId: `operation-write-${writeIdentity}`,
      ...scope.provenanceContext,
      messageAncestry: [...scope.messageAncestry],
      notebookSessionId: scope.sessionId,
      producerRunId: output.producerRunId,
      filename: output.filename,
      contentType: output.contentType,
      source: artifactSource
    }
    if (output.publication || recovery) {
      const digest =
        artifactSource.kind === 'inline'
          ? {
              checksum: createHash('sha256')
                .update(Buffer.from(artifactSource.content, 'base64'))
                .digest('hex'),
              sizeBytes: Buffer.from(artifactSource.content, 'base64').length
            }
          : await digestFileWithinBudget(
              artifactSource.path,
              LOCAL_RESOURCE_BUDGETS.artifactFileBytes,
              writeSignal
            )
      const generation =
        artifactSource.kind === 'localPath' && producer
          ? (
              await Promise.all(
                (producer.workingFiles ?? []).map(async (file) =>
                  file.createdByRunId === producer!.runId &&
                  file.checksum === digest.checksum &&
                  file.size === digest.sizeBytes &&
                  (await realpath(file.path).catch(() => undefined)) === artifactSource.path
                    ? file
                    : undefined
                )
              )
            ).filter((file) => file !== undefined)
          : []
      const generationId = generation.length === 1 ? generation[0]!.generationId : undefined
      if (
        recovery &&
        (digest.checksum !== recovery.output.sha256 ||
          digest.sizeBytes !== recovery.output.sizeBytes ||
          generationId !== recovery.output.generationId)
      )
        throw new Error('Retained output no longer matches its original file generation.')
      const attempt = freezeManagedOutputWriteAttempt({
        schemaVersion: 1,
        request: {
          projectId: request.projectId,
          appSessionId: request.appSessionId,
          artifactStorageSessionId: request.artifactStorageSessionId,
          artifactRunId: request.artifactRunId,
          writeOperationId: request.writeOperationId,
          filename: request.filename,
          ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
          ...(request.producerRunId ? { producerRunId: request.producerRunId } : {})
        },
        destination: {
          provenanceContext: scope.provenanceContext,
          messageAncestry: [...scope.messageAncestry]
        },
        source: {
          kind: output.source.kind,
          sha256: digest.checksum,
          sizeBytes: digest.sizeBytes,
          ...(output.producerRunId
            ? {
                producerRunId: output.producerRunId,
                producerProvenance: recovery?.producerProvenance ?? scope.provenanceContext
              }
            : {}),
          ...(generationId ? { generationId } : {}),
          ...(output.source.kind === 'inline' ? {} : { relativePath: output.source.path })
        }
      })
      await output.publication?.beforeWrite(attempt)
      writeSignal.throwIfAborted()
      recovery?.signal.throwIfAborted()
      writeScope = {
        ...writeScope,
        expectedContent: { checksum: digest.checksum, sizeBytes: digest.sizeBytes }
      }
    }
    const artifact = await dependencies.artifacts.saveVersion(request, writeScope, writeSignal)
    await observers.onArtifact?.(artifact)
    return artifact
  }
  return {
    notebookDataDir: source.notebookDataDir,
    async recordRun(runId) {
      await findRun(runId)
      await observers.onRun?.(runId)
      recorded.add(runId)
    },
    saveOutput: (output) => save(output),
    async recoverOutput(output) {
      if (output.publication.previousAttempts.length > 1000)
        throw new Error('Too many Artifact recovery write attempts.')
      output = {
        ...output,
        source: { ...output.source },
        publication: {
          beforeWrite: output.publication.beforeWrite.bind(output.publication),
          previousAttempts: output.publication.previousAttempts.map(freezeManagedOutputWriteAttempt)
        }
      }
      signal.throwIfAborted()
      const proof = resolveManagedOutputRecoveryAuthority(output.recoveryAuthority, scope, {
        filename: output.filename,
        path: output.source.path,
        producerRunId: output.producerRunId
      })
      const original = proof.producerProvenance
      if (
        original.rootFrameId !== scope.provenanceContext.rootFrameId ||
        original.agentFrameId !== scope.provenanceContext.agentFrameId ||
        original.messageBranchId !== scope.provenanceContext.messageBranchId ||
        !scope.messageAncestry.includes(original.promptMessageId) ||
        (original.promptMessageId === scope.provenanceContext.promptMessageId &&
          original.runtimeSegmentId !== scope.provenanceContext.runtimeSegmentId)
      )
        throw new Error('Recovered output is not an ancestor of the current Artifact turn.')
      const producer = await findRun(output.producerRunId, original)
      if (
        producer.status === 'queued' ||
        producer.status === 'running' ||
        producer.kernelKind !== 'bash'
      )
        throw new Error('Recovered output requires its original terminal managed Run.')
      const generations = producer.workingFiles.filter(
        (file) =>
          file.createdByRunId === producer.runId &&
          file.generationId === proof.output.generationId &&
          file.checksum === proof.output.sha256 &&
          file.size === proof.output.sizeBytes
      )
      if (generations.length !== 1)
        throw new Error('Original output generation is unavailable or ambiguous.')
      const attempts = output.publication.previousAttempts.map((value) =>
        managedOutputWriteAttemptSchema.parse(value)
      )
      for (const attempt of attempts) {
        const destination = attempt.destination.provenanceContext
        if (
          attempt.request.projectId !== scope.projectId ||
          attempt.request.appSessionId !== scope.sessionId ||
          attempt.request.filename !== output.filename ||
          attempt.request.contentType !== output.contentType ||
          attempt.request.producerRunId !== producer.runId ||
          attempt.source.kind !== 'managedOutput' ||
          attempt.source.relativePath !== proof.output.path ||
          attempt.source.generationId !== proof.output.generationId ||
          attempt.source.sha256 !== proof.output.sha256 ||
          attempt.source.sizeBytes !== proof.output.sizeBytes ||
          !attempt.source.producerProvenance ||
          Object.entries(original).some(
            ([key, value]) =>
              attempt.source.producerProvenance![key as keyof ManagedExecutionProvenance] !== value
          ) ||
          destination.rootFrameId !== scope.provenanceContext.rootFrameId ||
          destination.agentFrameId !== scope.provenanceContext.agentFrameId ||
          destination.messageBranchId !== scope.provenanceContext.messageBranchId ||
          !scope.messageAncestry.includes(destination.promptMessageId) ||
          !attempt.destination.messageAncestry.includes(original.promptMessageId)
        )
          throw new Error('Artifact recovery write intent does not match the retained output.')
      }
      for (const attempt of attempts) {
        proof.signal.throwIfAborted()
        signal.throwIfAborted()
        const artifact = await dependencies.artifacts.replayVersion(attempt.request)
        if (!artifact) continue
        proof.signal.throwIfAborted()
        signal.throwIfAborted()
        if (
          artifact.checksum !== proof.output.sha256 ||
          artifact.size !== proof.output.sizeBytes ||
          artifact.producerRunId !== producer.runId
        )
          throw new Error('Recovered Artifact Version does not match its original output.')
        if (artifact.isPublished !== true)
          throw new Error('Recovered Artifact Version is not yet published by its original turn.')
        // This Version remains attached to its original turn. Do not register it for current-turn finalization.
        return { artifact, reused: true }
      }
      return { artifact: await save(output, proof), reused: false }
    }
  }
}
