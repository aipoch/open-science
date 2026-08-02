import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ArtifactFile } from '../../shared/artifacts'
import type { ArtifactRpcCapabilityBinding } from '../../shared/artifact-provenance'
import { getNotebookDataRoot, getNotebookSessionRoot } from '../notebook/repository'
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
}

type OpenArtifactTurnRequest = {
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
  appSessionId: string
  runId: string
  phase: 'open' | 'sealing' | 'finalized' | 'disposed'
  outstandingWrites: number
  terminalResult?: { kind: 'empty' } | { kind: 'publication'; artifactCount: number }
}

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
  notebook?: {
    setArtifactProvenanceContext?: (
      sessionId: string,
      context:
        | {
            rootFrameId: string
            agentFrameId: string
            messageBranchId: string
            runtimeSegmentId: string
            promptMessageId: string
          }
        | undefined
    ) => void
  }
}

type ArtifactTurn = {
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
  agentName: string
  rpcCapabilityToken?: string
  phase: 'open' | 'sealing' | 'finalized' | 'disposed'
  inFlightAppWrites: Set<Promise<ArtifactFile>>
  writeDrainPromise?: Promise<void>
  finalizationPromise?: Promise<ArtifactTurnPublication | undefined>
  disposalPromise?: Promise<void>
  terminalResult?: { kind: 'empty' } | { kind: 'publication'; artifactCount: number }
}

class ArtifactTurnOwner {
  private readonly activeTurnsBySession = new Map<string, ArtifactTurn>()
  private readonly turnsByHandle = new WeakMap<ArtifactTurnHandle, ArtifactTurn>()
  private readonly runtimeInstanceId: string
  private readonly now: () => number
  private sequence = 0

  constructor(private readonly options: ArtifactTurnOwnerOptions) {
    this.runtimeInstanceId = options.runtimeInstanceId ?? randomUUID()
    this.now = options.now ?? Date.now
  }

  async open(request: OpenArtifactTurnRequest): Promise<ArtifactTurnHandle> {
    const turn = this.createTurn(request)
    const runContext = this.createRunContext(turn)

    turn.rpcCapabilityToken = this.options.issueRpcCapability?.({
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
      ...(this.options.notebook ? { notebookSessionId: turn.appSessionId } : {}),
      allowedMethods: ['artifactCreateVersion', 'artifactReplayVersion']
    })
    if (turn.rpcCapabilityToken) runContext.rpcCapabilityToken = turn.rpcCapabilityToken

    try {
      await mkdir(dirname(turn.currentRunFile), { recursive: true })
      await writeFile(turn.currentRunFile, `${JSON.stringify(runContext)}\n`, 'utf8')
      this.options.notebook?.setArtifactProvenanceContext?.(turn.appSessionId, {
        rootFrameId: turn.rootFrameId,
        agentFrameId: turn.agentFrameId,
        messageBranchId: turn.messageBranchId,
        runtimeSegmentId: turn.runtimeSegmentId,
        promptMessageId: turn.promptMessageId
      })
    } catch (error) {
      if (turn.rpcCapabilityToken) {
        await this.options.revokeRpcCapability?.(turn.rpcCapabilityToken)
      }
      throw error
    }

    this.activeTurnsBySession.set(turn.appSessionId, turn)
    const handle: ArtifactTurnHandle = { [artifactTurnHandleKey]: Symbol(turn.runId) }
    this.turnsByHandle.set(handle, turn)
    return handle
  }

  activeRunIds(): string[] {
    return Array.from(this.activeTurnsBySession.values(), (turn) => turn.runId)
  }

  promptMessageIdFor(sessionId: string): string | undefined {
    return this.activeTurnsBySession.get(sessionId)?.promptMessageId
  }

  snapshot(handle: ArtifactTurnHandle): ArtifactTurnSnapshot {
    const turn = this.resolve(handle)
    return {
      appSessionId: turn.appSessionId,
      runId: turn.runId,
      phase: turn.phase,
      outstandingWrites: turn.inFlightAppWrites.size,
      ...(turn.terminalResult ? { terminalResult: turn.terminalResult } : {})
    }
  }

  writeForActiveTurn(
    sessionId: string,
    input: ArtifactTurnWriteInput
  ): Promise<ArtifactFile> {
    const turn = sessionId ? this.activeTurnsBySession.get(sessionId) : undefined
    if (!turn || turn.phase !== 'open') {
      return Promise.reject(new Error('No active assistant turn to attach a generated file to.'))
    }

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
          contentType: input.mimeType
        })
      : this.options.repository.writePendingFile({
          projectName: turn.projectId,
          sessionId: turn.artifactStorageSessionId,
          runId: turn.runId,
          filename: input.filename,
          mimeType: input.mimeType,
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
    turn.finalizationPromise ??= this.finalizeTurn(turn)
    return turn.finalizationPromise
  }

  dispose(handle: ArtifactTurnHandle): Promise<void> {
    const turn = this.resolve(handle)
    turn.disposalPromise ??= this.disposeTurn(turn)
    return turn.disposalPromise
  }

  private createTurn(request: OpenArtifactTurnRequest): ArtifactTurn {
    this.sequence += 1
    const runId = `artifact-run-${this.now()}-${this.sequence}`
    const rootFrameId = request.provenanceContext?.rootFrameId ?? `root-frame-${request.appSessionId}`
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

    return {
      appSessionId: request.appSessionId,
      artifactStorageSessionId: request.artifactStorageSessionId,
      projectId: request.projectId,
      runId,
      currentRunFile: getArtifactCurrentRunFilePath(
        this.options.dataRoot,
        request.projectId,
        request.artifactStorageSessionId
      ),
      rootFrameId,
      agentFrameId: request.provenanceContext?.agentFrameId ?? rootFrameId,
      messageBranchId,
      messageBranchAncestry,
      messageAncestry,
      runtimeSegmentId:
        request.provenanceContext?.runtimeSegmentId ??
        `runtime-segment-${this.runtimeInstanceId}`,
      promptMessageId,
      agentName: request.agentName,
      phase: 'open',
      inFlightAppWrites: new Set()
    }
  }

  private createRunContext(turn: ArtifactTurn): ArtifactRunContext {
    const base = {
      artifactRunId: turn.runId,
      appSessionId: turn.appSessionId,
      rootFrameId: turn.rootFrameId,
      agentFrameId: turn.agentFrameId,
      messageBranchId: turn.messageBranchId,
      messageBranchAncestry: turn.messageBranchAncestry,
      messageAncestry: turn.messageAncestry,
      runtimeSegmentId: turn.runtimeSegmentId,
      promptMessageId: turn.promptMessageId,
      agentName: turn.agentName
    }
    return this.options.notebook
      ? {
          ...base,
          notebookSessionId: turn.appSessionId,
          notebookDataDir: getNotebookDataRoot(
            this.options.dataRoot,
            turn.projectId,
            turn.appSessionId
          ),
          notebookSessionRoot: getNotebookSessionRoot(
            this.options.dataRoot,
            turn.projectId,
            turn.appSessionId
          )
        }
      : base
  }

  private closeWrites(turn: ArtifactTurn): Promise<void> {
    if (turn.writeDrainPromise) return turn.writeDrainPromise

    turn.phase = 'sealing'
    const rpcDrain = turn.rpcCapabilityToken
      ? Promise.resolve().then(() =>
          this.options.revokeRpcCapability?.(turn.rpcCapabilityToken as string)
        )
      : Promise.resolve()
    turn.writeDrainPromise = (async () => {
      await rpcDrain
      await Promise.allSettled([...turn.inFlightAppWrites])
    })()
    return turn.writeDrainPromise
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
      artifactVersionIds = artifacts.map((artifact) => artifact.versionId).filter(Boolean) as string[]
    } else {
      artifacts = await this.options.repository.listPendingRunFiles({
        projectName: turn.projectId,
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
      projectName: turn.projectId,
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
      projectName: turn.projectId,
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

  private async disposeTurn(turn: ArtifactTurn): Promise<void> {
    let hasDrainError = false
    let drainError: unknown
    try {
      await this.closeWrites(turn)
    } catch (error) {
      hasDrainError = true
      drainError = error
    }
    const ownsActiveTurn = this.activeTurnsBySession.get(turn.appSessionId) === turn
    try {
      if (ownsActiveTurn) {
        await writeFile(turn.currentRunFile, `${JSON.stringify({})}\n`, 'utf8')
        this.options.notebook?.setArtifactProvenanceContext?.(turn.appSessionId, undefined)
      }
    } finally {
      if (this.activeTurnsBySession.get(turn.appSessionId) === turn) {
        this.activeTurnsBySession.delete(turn.appSessionId)
      }
      turn.phase = 'disposed'
    }
    if (hasDrainError) throw drainError
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
  ArtifactTurnPublication,
  ArtifactTurnSnapshot,
  ArtifactTurnWriteInput,
  OpenArtifactTurnRequest
}
