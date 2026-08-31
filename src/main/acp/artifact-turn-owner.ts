import { randomUUID } from 'node:crypto'
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ArtifactFile } from '../../shared/artifacts'
import type {
  AppGeneratedArtifactProducer,
  ArtifactRpcCapabilityBinding
} from '../../shared/artifact-provenance'
import type { ArtifactRunContext } from '../artifacts/mcp-server'
import { ArtifactRepository, getArtifactCurrentRunFilePath } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'

const artifactTurnHandleKey = Symbol('artifact-turn-handle')

type ArtifactTurnHandle = {
  readonly [artifactTurnHandleKey]: symbol
}

type ArtifactTurnProvenanceContext = {
  rootFrameId?: string
  agentFrameId?: string
  messageBranchId?: string
  messageBranchAncestry?: string[]
  messageAncestry?: string[]
  runtimeSegmentId?: string
  promptMessageId?: string
  originMessageId?: string
}

type OpenExecutionArtifactTurnRequest = {
  executionId: string
  appSessionId: string
  artifactStorageSessionId: string
  projectId: string
  agentName: string
  provenanceContext?: ArtifactTurnProvenanceContext
}

type ArtifactTurnWriteInput = {
  filename: string
  content: string
  mimeType?: string
  kind?: 'plan'
  producer?: AppGeneratedArtifactProducer
}

type ArtifactTurnPublication = {
  appSessionId: string
  artifactStorageSessionId: string
  runId: string
  promptMessageId: string
  artifactClaimId: string
  artifacts: ArtifactFile[]
}

type ArtifactTurnSnapshot = {
  executionId?: string
  appSessionId: string
  runId: string
  agentFrameId?: string
  messageBranchId?: string
  runtimeSegmentId?: string
  promptMessageId?: string
  phase: 'open' | 'sealing' | 'finalized' | 'disposed'
  outstandingWrites: number
  terminalResult?: { kind: 'empty' } | { kind: 'publication'; artifactCount: number }
}

type NotebookArtifactSourceScope = Required<
  Pick<ArtifactRunContext, 'notebookSessionId' | 'notebookDataDir' | 'notebookSessionRoot'>
>

type NotebookArtifactSourceScopeRequest = Readonly<{
  projectId: string
  appSessionId: string
  rootFrameId: string
  agentFrameId: string
}>

type NotebookArtifactSourceScopeProvider = (
  request: NotebookArtifactSourceScopeRequest
) => NotebookArtifactSourceScope

type ArtifactTurnProvenance = {
  listRunVersions: (request: {
    projectId: string
    appSessionId: string
    artifactRunId: string
  }) => Promise<ArtifactFile[]>
  writeAppGeneratedVersion: (request: {
    projectId: string
    appSessionId: string
    artifactStorageSessionId: string
    artifactRunId: string
    rootFrameId: string
    agentFrameId: string
    messageBranchId: string
    messageBranchAncestry: string[]
    messageAncestry: string[]
    runtimeSegmentId: string
    promptMessageId: string
    agentName: string
    filename: string
    content: string
    contentType?: string
    kind?: 'plan'
    producer?: AppGeneratedArtifactProducer
  }) => Promise<ArtifactFile>
}

type ArtifactTurnOwnerOptions = {
  dataRoot: string
  repository: ArtifactRepository
  runRegistry: ArtifactRunRegistry
  runtimeInstanceId?: string
  now?: () => number
  issueRpcCapability?: (binding: ArtifactRpcCapabilityBinding) => string
  revokeRpcCapability?: (token: string) => Promise<void> | void
  provenance?: ArtifactTurnProvenance
  writeHandoffFile?: (filePath: string, content: string) => Promise<void>
  notebookArtifactSourceScope?: NotebookArtifactSourceScopeProvider
  notebook?: {
    setArtifactTurnBinding?: (
      sessionId: string,
      binding: {
        ownerExecutionId: string
        projectId: string
        provenanceContext: {
          rootFrameId: string
          agentFrameId: string
          messageBranchId: string
          runtimeSegmentId: string
          promptMessageId: string
          originMessageId?: string
        }
      }
    ) => void
    clearArtifactTurnBinding?: (sessionId: string, ownerExecutionId: string) => void
  }
}

type ArtifactTurn = {
  executionId: string
  updatesSessionNotebookContext: boolean
  appSessionId: string
  artifactStorageSessionId: string
  projectId: string
  runId: string
  currentRunFile: string
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  messageBranchAncestry: string[]
  messageAncestry: string[]
  runtimeSegmentId: string
  promptMessageId: string
  originMessageId?: string
  agentName: string
  rpcCapabilityToken?: string
  notebookArtifactSourceScope?: NotebookArtifactSourceScope
  phase: 'open' | 'sealing' | 'finalized' | 'disposed'
  inFlightAppWrites: Set<Promise<ArtifactFile>>
  writeDrainPromise?: Promise<void>
  finalizationPromise?: Promise<ArtifactTurnPublication | undefined>
  disposalPromise?: Promise<void>
  disposalStarted: boolean
  terminalResult?: { kind: 'empty' } | { kind: 'publication'; artifactCount: number }
}

class ArtifactTurnOwner {
  private readonly activeTurnsByExecution = new Map<string, ArtifactTurn>()
  private readonly activeHandlesByExecution = new Map<string, ArtifactTurnHandle>()
  private readonly activeTurnsByHandoffFile = new Map<string, ArtifactTurn>()
  private readonly handoffQueues = new Map<string, Promise<void>>()
  private readonly turnsByHandle = new WeakMap<ArtifactTurnHandle, ArtifactTurn>()
  private readonly runtimeInstanceId: string
  private readonly now: () => number
  private sequence = 0

  constructor(private readonly options: ArtifactTurnOwnerOptions) {
    this.runtimeInstanceId = options.runtimeInstanceId ?? randomUUID()
    this.now = options.now ?? Date.now
  }

  async openExecution(request: OpenExecutionArtifactTurnRequest): Promise<ArtifactTurnHandle> {
    return this.openScopedExecution(request, false)
  }

  // Root providers receive one stable MCP transport configuration when their ACP Session starts.
  // This method preserves that compatibility handoff location without restoring Session lookup as
  // write authority: every lifecycle operation still requires the returned execution handle.
  async openRootExecution(request: OpenExecutionArtifactTurnRequest): Promise<ArtifactTurnHandle> {
    return this.openScopedExecution(request, true)
  }

  private async openScopedExecution(
    request: OpenExecutionArtifactTurnRequest,
    rootTransport: boolean
  ): Promise<ArtifactTurnHandle> {
    if (!request.executionId.trim()) throw new Error('Artifact execution id is required.')
    if (this.activeTurnsByExecution.has(request.executionId)) {
      throw new Error(`Artifact execution is already active: ${request.executionId}`)
    }
    return this.activate(this.createTurn(request, rootTransport))
  }

  private async activate(turn: ArtifactTurn): Promise<ArtifactTurnHandle> {
    const runContext = this.createRunContext(turn)
    return this.withHandoffLock(turn.currentRunFile, async () => {
      let handoffWritten = false

      turn.rpcCapabilityToken = this.options.issueRpcCapability?.({
        executionId: turn.executionId,
        projectId: turn.projectId,
        appSessionId: turn.appSessionId,
        artifactStorageSessionId: turn.artifactStorageSessionId,
        artifactRunId: turn.runId,
        rootFrameId: turn.rootFrameId,
        agentFrameId: turn.agentFrameId,
        messageBranchId: turn.messageBranchId,
        messageBranchAncestry: turn.messageBranchAncestry,
        messageAncestry: turn.messageAncestry,
        runtimeSegmentId: turn.runtimeSegmentId,
        promptMessageId: turn.promptMessageId,
        agentName: turn.agentName,
        ...(turn.notebookArtifactSourceScope
          ? { notebookSessionId: turn.notebookArtifactSourceScope.notebookSessionId }
          : {}),
        allowedMethods: [
          'artifactReserveWrite',
          'artifactReleaseWrite',
          'artifactCreateVersion',
          'artifactReplayVersion'
        ]
      })
      if (turn.rpcCapabilityToken) runContext.rpcCapabilityToken = turn.rpcCapabilityToken

      try {
        await mkdir(dirname(turn.currentRunFile), { recursive: true })
        await this.writeHandoffFile(turn.currentRunFile, runContext)
        handoffWritten = true
        if (turn.updatesSessionNotebookContext) {
          this.options.notebook?.setArtifactTurnBinding?.(turn.appSessionId, {
            ownerExecutionId: turn.executionId,
            projectId: turn.projectId,
            provenanceContext: {
              rootFrameId: turn.rootFrameId,
              agentFrameId: turn.agentFrameId,
              messageBranchId: turn.messageBranchId,
              runtimeSegmentId: turn.runtimeSegmentId,
              promptMessageId: turn.promptMessageId,
              ...(turn.originMessageId ? { originMessageId: turn.originMessageId } : {})
            }
          })
        }
      } catch (error) {
        if (turn.rpcCapabilityToken) {
          try {
            await this.options.revokeRpcCapability?.(turn.rpcCapabilityToken)
          } catch {
            // Preserve the activation failure while still attempting every remaining cleanup stage.
          }
        }
        if (handoffWritten) {
          try {
            await this.writeHandoffFile(turn.currentRunFile, {})
          } catch {
            // The original activation failure remains the caller-visible error.
          }
          if (turn.updatesSessionNotebookContext) {
            try {
              this.options.notebook?.clearArtifactTurnBinding?.(turn.appSessionId, turn.executionId)
            } catch {
              // The original activation failure remains the caller-visible error.
            }
          }
        }
        throw error
      }

      this.activeTurnsByExecution.set(turn.executionId, turn)
      this.activeTurnsByHandoffFile.set(turn.currentRunFile, turn)
      const handle: ArtifactTurnHandle = { [artifactTurnHandleKey]: Symbol(turn.runId) }
      this.turnsByHandle.set(handle, turn)
      this.activeHandlesByExecution.set(turn.executionId, handle)
      return handle
    })
  }

  activeRunIds(): string[] {
    return Array.from(this.activeTurnsByExecution.values(), (turn) => turn.runId)
  }

  handleForExecution(executionId: string): ArtifactTurnHandle {
    const handle = this.activeHandlesByExecution.get(executionId)
    if (!handle) throw new Error(`No active Artifact turn for execution: ${executionId}`)
    return handle
  }

  handoffFile(handle: ArtifactTurnHandle): string {
    return this.resolve(handle).currentRunFile
  }

  async publishHandoff(handle: ArtifactTurnHandle, targetFile: string): Promise<void> {
    const turn = this.resolve(handle)
    if (turn.phase !== 'open') throw new Error('Artifact turn is not open.')
    await this.withHandoffLock(targetFile, async () => {
      await mkdir(dirname(targetFile), { recursive: true })
      await this.writeHandoffFile(targetFile, this.createRunContext(turn))
    })
  }

  snapshot(handle: ArtifactTurnHandle): ArtifactTurnSnapshot {
    const turn = this.resolve(handle)
    return {
      executionId: turn.executionId,
      agentFrameId: turn.agentFrameId,
      messageBranchId: turn.messageBranchId,
      runtimeSegmentId: turn.runtimeSegmentId,
      promptMessageId: turn.promptMessageId,
      appSessionId: turn.appSessionId,
      runId: turn.runId,
      phase: turn.phase,
      outstandingWrites: turn.inFlightAppWrites.size,
      ...(turn.terminalResult ? { terminalResult: turn.terminalResult } : {})
    }
  }

  write(handle: ArtifactTurnHandle, input: ArtifactTurnWriteInput): Promise<ArtifactFile> {
    const turn = this.resolve(handle)
    if (turn.phase !== 'open') {
      return Promise.reject(new Error('Artifact turn is not open for writes.'))
    }
    return this.writeTurn(turn, input)
  }

  private writeTurn(turn: ArtifactTurn, input: ArtifactTurnWriteInput): Promise<ArtifactFile> {
    const write = this.options.provenance
      ? this.options.provenance.writeAppGeneratedVersion({
          projectId: turn.projectId,
          appSessionId: turn.appSessionId,
          artifactStorageSessionId: turn.artifactStorageSessionId,
          artifactRunId: turn.runId,
          rootFrameId: turn.rootFrameId,
          agentFrameId: turn.agentFrameId,
          messageBranchId: turn.messageBranchId,
          messageBranchAncestry: turn.messageBranchAncestry,
          messageAncestry: turn.messageAncestry,
          runtimeSegmentId: turn.runtimeSegmentId,
          promptMessageId: turn.promptMessageId,
          agentName: turn.agentName,
          filename: input.filename,
          content: input.content,
          contentType: input.mimeType,
          kind: input.kind,
          producer: input.producer
        })
      : this.options.repository.writePendingFile({
          projectId: turn.projectId,
          sessionId: turn.artifactStorageSessionId,
          runId: turn.runId,
          filename: input.filename,
          mimeType: input.mimeType,
          kind: input.kind,
          source: { kind: 'inline', content: input.content, encoding: 'utf8' }
        })

    turn.inFlightAppWrites.add(write)
    void write.then(
      () => turn.inFlightAppWrites.delete(write),
      () => turn.inFlightAppWrites.delete(write)
    )
    return write
  }

  finalize(handle: ArtifactTurnHandle): Promise<ArtifactTurnPublication | undefined> {
    const turn = this.resolve(handle)
    if (turn.disposalStarted && !turn.finalizationPromise) {
      return Promise.reject(new Error('Artifact turn is already disposing or disposed.'))
    }
    if (!turn.finalizationPromise) {
      const finalization = this.finalizeTurn(turn)
      turn.finalizationPromise = finalization
      void finalization.catch(() => {
        // Claim preparation can fail transiently. Preserve the runtime's existing finally retry while
        // keeping a concurrent disposal terminal and non-reopenable.
        if (turn.finalizationPromise === finalization && !turn.disposalPromise) {
          turn.finalizationPromise = undefined
        }
      })
    }
    return turn.finalizationPromise
  }

  dispose(handle: ArtifactTurnHandle): Promise<void> {
    const turn = this.resolve(handle)
    if (!turn.disposalPromise) {
      turn.disposalStarted = true
      const disposal = this.disposeAfterFinalization(turn)
      turn.disposalPromise = disposal
      void disposal.catch(() => {
        if (turn.disposalPromise === disposal) turn.disposalPromise = undefined
      })
    }
    return turn.disposalPromise
  }

  private createTurn(
    request: OpenExecutionArtifactTurnRequest,
    rootTransport: boolean
  ): ArtifactTurn {
    this.sequence += 1
    const runId = `artifact-run-${this.now()}-${this.sequence}`
    const rootFrameId =
      request.provenanceContext?.rootFrameId ?? `root-frame-${request.appSessionId}`
    const messageBranchId =
      request.provenanceContext?.messageBranchId ?? `message-branch-${request.appSessionId}`
    const promptMessageId = request.provenanceContext?.promptMessageId ?? `prompt-${runId}`
    const messageBranchAncestry = [
      ...(request.provenanceContext?.messageBranchAncestry ?? []).filter(
        (branchId) => branchId !== messageBranchId
      ),
      messageBranchId
    ]
    const messageAncestry = [
      ...(request.provenanceContext?.messageAncestry ?? []).filter(
        (messageId) => messageId !== promptMessageId
      ),
      promptMessageId
    ]

    const sessionCurrentRunFile = getArtifactCurrentRunFilePath(
      this.options.dataRoot,
      request.projectId,
      request.artifactStorageSessionId
    )
    const turn: ArtifactTurn = {
      executionId: request.executionId,
      updatesSessionNotebookContext: rootTransport,
      appSessionId: request.appSessionId,
      artifactStorageSessionId: request.artifactStorageSessionId,
      projectId: request.projectId,
      runId,
      currentRunFile: rootTransport
        ? sessionCurrentRunFile
        : join(dirname(dirname(sessionCurrentRunFile)), '.execution-handoffs', `${runId}.json`),
      rootFrameId,
      agentFrameId: request.provenanceContext?.agentFrameId ?? rootFrameId,
      messageBranchId,
      messageBranchAncestry,
      messageAncestry,
      runtimeSegmentId:
        request.provenanceContext?.runtimeSegmentId ?? `runtime-segment-${this.runtimeInstanceId}`,
      promptMessageId,
      ...(request.provenanceContext?.originMessageId
        ? { originMessageId: request.provenanceContext.originMessageId }
        : {}),
      agentName: request.agentName,
      phase: 'open',
      inFlightAppWrites: new Set(),
      disposalStarted: false
    }
    const notebookArtifactSourceScope = this.options.notebookArtifactSourceScope?.({
      projectId: turn.projectId,
      appSessionId: turn.appSessionId,
      rootFrameId: turn.rootFrameId,
      agentFrameId: turn.agentFrameId
    })
    return notebookArtifactSourceScope ? { ...turn, notebookArtifactSourceScope } : turn
  }

  private createRunContext(turn: ArtifactTurn): ArtifactRunContext {
    return {
      artifactRunId: turn.runId,
      executionId: turn.executionId,
      appSessionId: turn.appSessionId,
      artifactStorageSessionId: turn.artifactStorageSessionId,
      rootFrameId: turn.rootFrameId,
      agentFrameId: turn.agentFrameId,
      messageBranchId: turn.messageBranchId,
      messageBranchAncestry: turn.messageBranchAncestry,
      messageAncestry: turn.messageAncestry,
      runtimeSegmentId: turn.runtimeSegmentId,
      promptMessageId: turn.promptMessageId,
      agentName: turn.agentName,
      ...turn.notebookArtifactSourceScope
    }
  }

  private closeWrites(turn: ArtifactTurn): Promise<void> {
    if (turn.writeDrainPromise) return turn.writeDrainPromise

    turn.phase = 'sealing'
    const rpcDrain = turn.rpcCapabilityToken
      ? Promise.resolve().then(() =>
          this.options.revokeRpcCapability?.(turn.rpcCapabilityToken as string)
        )
      : Promise.resolve()
    const writeDrain = (async () => {
      const [rpcResult] = await Promise.allSettled([
        rpcDrain,
        Promise.allSettled([...turn.inFlightAppWrites])
      ])
      if (rpcResult.status === 'rejected') throw rpcResult.reason
    })()
    turn.writeDrainPromise = writeDrain
    void writeDrain.catch(() => {
      if (turn.writeDrainPromise === writeDrain) turn.writeDrainPromise = undefined
    })
    return writeDrain
  }

  private async finalizeTurn(turn: ArtifactTurn): Promise<ArtifactTurnPublication | undefined> {
    await this.closeWrites(turn)

    let artifacts: ArtifactFile[]
    let artifactVersionIds: string[] | undefined
    if (this.options.provenance) {
      artifacts = await this.options.provenance.listRunVersions({
        projectId: turn.projectId,
        appSessionId: turn.appSessionId,
        artifactRunId: turn.runId
      })
      artifactVersionIds = artifacts
        .map((artifact) => artifact.versionId)
        .filter(Boolean) as string[]
    } else {
      artifacts = await this.options.repository.listPendingRunFiles({
        projectId: turn.projectId,
        sessionId: turn.artifactStorageSessionId,
        runId: turn.runId
      })
    }

    if (artifacts.length === 0) {
      turn.phase = 'finalized'
      turn.terminalResult = { kind: 'empty' }
      return undefined
    }

    await this.options.repository.prepareRunFinalization({
      projectId: turn.projectId,
      sourceSessionId: turn.artifactStorageSessionId,
      sessionId: turn.appSessionId,
      runId: turn.runId,
      ...(artifactVersionIds ? { artifactVersionIds } : {}),
      provenanceContext: {
        rootFrameId: turn.rootFrameId,
        agentFrameId: turn.agentFrameId,
        messageBranchId: turn.messageBranchId,
        runtimeSegmentId: turn.runtimeSegmentId,
        promptMessageId: turn.promptMessageId
      }
    })

    const artifactClaimId = this.options.runRegistry.register({
      projectId: turn.projectId,
      artifactSessionId: turn.artifactStorageSessionId,
      sessionId: turn.appSessionId,
      runId: turn.runId,
      artifactVersionIds,
      rootFrameId: turn.rootFrameId,
      agentFrameId: turn.agentFrameId,
      messageBranchId: turn.messageBranchId,
      messageBranchAncestry: turn.messageBranchAncestry,
      messageAncestry: turn.messageAncestry,
      runtimeSegmentId: turn.runtimeSegmentId,
      promptMessageId: turn.promptMessageId
    })
    const publication = {
      appSessionId: turn.appSessionId,
      artifactStorageSessionId: turn.artifactStorageSessionId,
      runId: turn.runId,
      promptMessageId: turn.promptMessageId,
      artifactClaimId,
      artifacts
    }
    turn.phase = 'finalized'
    turn.terminalResult = { kind: 'publication', artifactCount: artifacts.length }
    return publication
  }

  private async disposeAfterFinalization(turn: ArtifactTurn): Promise<void> {
    if (turn.finalizationPromise) {
      try {
        await turn.finalizationPromise
      } catch {
        // Disposal must still clear every ephemeral resource after failed claim preparation.
      }
    }
    await this.disposeTurn(turn)
  }

  private async disposeTurn(turn: ArtifactTurn): Promise<void> {
    const cleanupErrors: unknown[] = []
    try {
      await this.closeWrites(turn)
    } catch (error) {
      cleanupErrors.push(error)
    }

    await this.withHandoffLock(turn.currentRunFile, async () => {
      const ownsExecutionTurn = this.activeTurnsByExecution.get(turn.executionId) === turn
      const ownsHandoff = this.activeTurnsByHandoffFile.get(turn.currentRunFile) === turn
      try {
        if (ownsExecutionTurn && ownsHandoff) {
          if (turn.updatesSessionNotebookContext) {
            await this.writeHandoffFile(turn.currentRunFile, {})
          } else {
            await rm(turn.currentRunFile, { force: true })
            await rmdir(dirname(turn.currentRunFile)).catch((error: unknown) => {
              if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                ((error as { code?: unknown }).code === 'ENOENT' ||
                  (error as { code?: unknown }).code === 'ENOTEMPTY')
              ) {
                return
              }
              throw error
            })
          }
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        if (turn.updatesSessionNotebookContext) {
          this.options.notebook?.clearArtifactTurnBinding?.(turn.appSessionId, turn.executionId)
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (cleanupErrors.length === 0) {
        if (this.activeTurnsByHandoffFile.get(turn.currentRunFile) === turn) {
          this.activeTurnsByHandoffFile.delete(turn.currentRunFile)
        }
        if (this.activeTurnsByExecution.get(turn.executionId) === turn) {
          this.activeTurnsByExecution.delete(turn.executionId)
          this.activeHandlesByExecution.delete(turn.executionId)
        }
        turn.phase = 'disposed'
      }
    })
    if (cleanupErrors.length > 0) throw cleanupErrors[0]
  }

  private writeHandoffFile(filePath: string, value: ArtifactRunContext | object): Promise<void> {
    const content = `${JSON.stringify(value)}\n`
    return this.options.writeHandoffFile
      ? this.options.writeHandoffFile(filePath, content)
      : writeFile(filePath, content, 'utf8')
  }

  private withHandoffLock<T>(handoffFile: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.handoffQueues.get(handoffFile) ?? Promise.resolve()
    const current = previous.then(operation)
    const tail = current.then(
      () => undefined,
      () => undefined
    )
    this.handoffQueues.set(handoffFile, tail)
    void tail.then(() => {
      if (this.handoffQueues.get(handoffFile) === tail) {
        this.handoffQueues.delete(handoffFile)
      }
    })
    return current
  }

  private resolve(handle: ArtifactTurnHandle): ArtifactTurn {
    const turn = this.turnsByHandle.get(handle)
    if (!turn) throw new Error('Unknown Artifact turn handle')
    return turn
  }
}

export { ArtifactTurnOwner }
export type {
  ArtifactTurnHandle,
  ArtifactTurnOwnerOptions,
  NotebookArtifactSourceScopeProvider,
  ArtifactTurnPublication,
  ArtifactTurnSnapshot,
  ArtifactTurnWriteInput,
  OpenExecutionArtifactTurnRequest
}
