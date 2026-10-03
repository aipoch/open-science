import { recordRestartTurnOutcome } from './turn-outcome-authority'
import { basename, dirname } from 'node:path'

import type {
  ArtifactVersionFile,
  ArtifactVersionDescriptor
} from '../../shared/artifact-provenance'
import {
  ARTIFACT_FINALIZATION_INVALID_PROOF,
  artifactCreatedAtMs,
  type ArtifactFile
} from '../../shared/artifacts'
import type { ProjectFileSource } from '../../shared/project-files'
import {
  materializeSessionConversationGraph,
  sessionRevision,
  setTurnOutcome,
  legacySessionStateForOutcome,
  latestOutcomePrompt,
  turnAnchorInterval,
  resolveTurnOutcome,
  type LoadAllSessionsResult,
  type PersistedArtifact,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type { ArtifactProjectReconciliationSnapshot } from '../artifacts/provenance-repository'
import { repairHistoricalArtifactAliases } from './artifact-alias-repair'
import { hasLegacySessionUpload } from './legacy-upload'
import { saveSessionWithRevision } from './save-session'

type SessionReconciliationRepository = {
  loadSessionWithDiagnostics?(
    projectId: string,
    sessionId: string,
    options: { preserveRuntimeState: true }
  ): Promise<
    { status: 'found'; session: PersistedChatSession } | { status: 'missing' | 'unreadable' }
  >
  saveSession(session: PersistedChatSession): Promise<PersistedChatSession>
  saveSessionWithBindingRepair?(
    session: PersistedChatSession,
    expectedRevision: number
  ): Promise<PersistedChatSession>
}

type SessionReconciliationFileIndex = {
  syncSession(
    session: PersistedChatSession,
    options?: { force?: boolean }
  ): Promise<ProjectFileSource[]>
  reconcileActiveSessions(sessions: PersistedChatSession[]): Promise<void>
}

type SessionReconciliationProvenance = {
  recoverLegacySessionGraph?(
    session: PersistedChatSession
  ): Promise<PersistedChatSession | undefined>
  captureFinalizedMessages(session: PersistedChatSession): Promise<void>
  reconcileSessionDeletions(activeSessions: PersistedChatSession[]): Promise<void>
  reconcileSessionCleanup?(activeSessions: PersistedChatSession[]): Promise<void>
  reconcileMessageSnapshots?(activeSessions: PersistedChatSession[]): Promise<void>
}

type SessionPermissionGrantReconciliation = {
  reconcileSessions(
    sessions: ReadonlyArray<{ projectId: string; sessionId: string }>
  ): Promise<void>
}

type SessionUploadPersistence = {
  upgradeLegacySessionUploads(
    session: PersistedChatSession,
    options?: { mode?: 'reconcile' | 'live-save' | 'orphan-recovery' | 'terminal-delete' }
  ): Promise<PersistedChatSession>
}

type ArtifactStorageReconciler = {
  resolveVersionDescriptors?(request: {
    projectId: string
    appSessionId: string
    versionIds: string[]
  }): Promise<ArtifactVersionDescriptor[]>
  prepareProjectReconciliation(projectId: string): Promise<ArtifactProjectReconciliationSnapshot>
  reconcileSession(
    projectId: string,
    sessionId: string,
    durableSession: PersistedChatSession,
    options?: {
      removeOrphanStaging?: boolean
      projectReconciliation?: ArtifactProjectReconciliationSnapshot
      artifactRunIds?: string[]
      artifactVersionIds?: string[]
    }
  ): Promise<
    | {
        recoveredMessageArtifacts: Array<{
          messageId: string
          artifacts: ArtifactVersionFile[]
        }>
        nativeFinalizationRunIds?: string[]
        unresolvedNativeFinalizationRunIds?: string[]
        invalidProofNativeFinalizationRunIds?: string[]
      }
    | undefined
  >
}

type PendingArtifactFinalizationRecovery = {
  artifacts: ArtifactVersionFile[]
  nativeRunIds: string[]
}

type SessionPersistenceReconciliationOwnerOptions = {
  onSessionCommitted?: (session: PersistedChatSession) => void
  ownsPromptPreparation?: (session: PersistedChatSession) => boolean
  repository: SessionReconciliationRepository
  fileIndex: SessionReconciliationFileIndex
  provenance?: SessionReconciliationProvenance
  uploads?: SessionUploadPersistence
  artifactStorage?: ArtifactStorageReconciler
  permissionGrants?: SessionPermissionGrantReconciliation
}

type ReconcileLoadedSessionsInput = {
  result: LoadAllSessionsResult
  allowDestructiveCleanup: boolean
  phase(name: string): void
  onPermissionFailure(error: unknown): void
}

type ReconcileLoadedSessionsOutcome =
  | { status: 'ready'; result: LoadAllSessionsResult }
  | { status: 'degraded'; result: LoadAllSessionsResult; failure: unknown }

type RecoveredMessageArtifacts = {
  messageId: string
  artifacts: ArtifactFile[]
  pendingPaths?: string[]
}

const toPersistedArtifact = (artifact: ArtifactFile): PersistedArtifact => {
  const createdAt = artifactCreatedAtMs(artifact.createdAt)
  return {
    id: artifact.id,
    artifactId: artifact.artifactId,
    versionId: artifact.versionId,
    versionNumber: artifact.versionNumber,
    kind: 'managed-file',
    path: artifact.path,
    fileUrl: artifact.fileUrl,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    ...(createdAt === undefined ? {} : { createdAt }),
    mtimeMs: artifact.mtimeMs,
    sha256: artifact.checksum
  }
}

const persistedArtifactsEqual = (left: PersistedArtifact, right: PersistedArtifact): boolean =>
  Object.entries(right).every(([field, value]) => left[field as keyof PersistedArtifact] === value)

const appendUnique = (existing: string[] | undefined, incoming: readonly string[]): string[] => {
  const result = [...(existing ?? [])]
  const seen = new Set(result)
  for (const value of incoming) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

// Reattach native Versions through the Session authority, preserving graph-only inactive Branches.
const attachRecoveredMessageArtifacts = (
  session: PersistedChatSession,
  recoveries: RecoveredMessageArtifacts[]
): PersistedChatSession => {
  if (recoveries.length === 0) return session

  const materialized = materializeSessionConversationGraph(session)
  const messageIds = new Set([
    ...materialized.messages.map((message) => message.id),
    ...(materialized.conversationGraph?.messages.map((message) => message.id) ?? [])
  ])
  const recoveredByMessage = new Map<string, Map<string, PersistedArtifact>>()
  for (const recovery of recoveries) {
    if (!messageIds.has(recovery.messageId)) continue
    const artifacts = recoveredByMessage.get(recovery.messageId) ?? new Map()
    for (const artifact of recovery.artifacts) {
      artifacts.set(artifact.id, toPersistedArtifact(artifact))
    }
    if (artifacts.size > 0) recoveredByMessage.set(recovery.messageId, artifacts)
  }
  if (recoveredByMessage.size === 0) return session

  const nextArtifacts = [...(materialized.artifacts ?? [])]
  const artifactIndexes = new Map(nextArtifacts.map((artifact, index) => [artifact.id, index]))
  let artifactsChanged = false
  for (const artifacts of recoveredByMessage.values()) {
    for (const artifact of artifacts.values()) {
      const index = artifactIndexes.get(artifact.id)
      if (index === undefined) {
        artifactIndexes.set(artifact.id, nextArtifacts.length)
        nextArtifacts.push(artifact)
        artifactsChanged = true
      } else if (!persistedArtifactsEqual(nextArtifacts[index], artifact)) {
        nextArtifacts[index] = artifact
        artifactsChanged = true
      }
    }
  }

  const now = Date.now()
  let flatMessagesChanged = false
  const messages = materialized.messages.map((message) => {
    const artifacts = recoveredByMessage.get(message.id)
    if (!artifacts) return message
    const recovered = recoveries.flatMap((recovery) =>
      recovery.messageId === message.id ? recovery.artifacts : []
    )
    const artifactIds = appendUnique(
      preserveUnrecoveredArtifactIds(
        message.artifactIds,
        materialized,
        recovered,
        recoveries.find((recovery) => recovery.messageId === message.id)?.pendingPaths
      ),
      [...artifacts.keys()]
    )
    if (JSON.stringify(artifactIds) === JSON.stringify(message.artifactIds ?? [])) return message
    flatMessagesChanged = true
    return { ...message, artifactIds, updatedAt: now }
  })
  let graphMessagesChanged = false
  const conversationGraph = materialized.conversationGraph
    ? {
        ...materialized.conversationGraph,
        messages: materialized.conversationGraph.messages.map((message) => {
          const artifacts = recoveredByMessage.get(message.id)
          if (!artifacts) return message
          const recovered = recoveries.flatMap((recovery) =>
            recovery.messageId === message.id ? recovery.artifacts : []
          )
          const artifactIds = appendUnique(
            preserveUnrecoveredArtifactIds(
              message.artifactIds,
              materialized,
              recovered,
              recoveries.find((recovery) => recovery.messageId === message.id)?.pendingPaths
            ),
            [...artifacts.keys()]
          )
          if (JSON.stringify(artifactIds) === JSON.stringify(message.artifactIds ?? []))
            return message
          graphMessagesChanged = true
          return { ...message, artifactIds, updatedAt: now }
        })
      }
    : undefined

  if (!artifactsChanged && !flatMessagesChanged && !graphMessagesChanged) return session
  return {
    ...materialized,
    artifacts: nextArtifacts,
    messages,
    conversationGraph,
    filesRevision: (materialized.filesRevision ?? 0) + 1,
    updatedAt: now
  }
}

const preserveUnrecoveredArtifactIds = (
  ids: string[] | undefined,
  session: PersistedChatSession,
  recovered: ArtifactFile[],
  pendingPaths: readonly string[] = []
): string[] => {
  return (ids ?? []).filter((id) => {
    const artifact = session.artifacts?.find((candidate) => candidate.id === id)
    const parts = artifact?.path.split(/[\\/]/) ?? []
    const index = parts.lastIndexOf('.pending')
    if (!artifact || index < 0) return true
    return !recovered.some(
      (confirmed) =>
        (artifact.versionId && artifact.versionId === confirmed.versionId) ||
        (confirmed.runId === parts[index + 1] && confirmed.name === parts.at(-1)) ||
        (confirmed.name === parts.at(-1) &&
          pendingPaths.includes(artifact.path) &&
          pendingPaths.filter((path) => path.split(/[\\/]/).at(-1) === confirmed.name).length === 1)
    )
  })
}

const settleRecoveredArtifactOutcomes = (
  session: PersistedChatSession,
  recovered: ArtifactFile[],
  priorPublished: readonly string[] = [],
  previous: PersistedChatSession = session
): PersistedChatSession => {
  const confirmed = new Set([
    ...priorPublished,
    ...recovered
      .filter((artifact) => artifact.isPublished && artifact.versionId)
      .map(({ versionId }) => versionId)
  ])
  let next = session
  const messages = session.conversationGraph?.messages ?? session.messages
  for (const prompt of messages) {
    const priorOutcome = resolveTurnOutcome(previous, prompt.id)
    if (
      prompt.role !== 'user' ||
      priorOutcome?.kind !== 'failed' ||
      priorOutcome.recovery !== 'retry-artifact-publication'
    )
      continue
    const legacyResponseIds = new Set<string>()
    if (!prompt.turnOutcome && latestOutcomePrompt(previous)?.id === prompt.id) {
      for (const message of turnAnchorInterval(previous.messages, prompt.id)) {
        if (message.role === 'agent' && !message.responseToMessageId)
          legacyResponseIds.add(message.id)
      }
    }
    const responses = messages.filter(
      (message) =>
        message.role === 'agent' &&
        (message.responseToMessageId === prompt.id || legacyResponseIds.has(message.id))
    )
    const artifactIds = responses.flatMap((message) => message.artifactIds ?? [])
    const artifacts = responses.flatMap((message) =>
      (message.artifactIds ?? []).flatMap((id) => {
        const artifact = session.artifacts?.find((candidate) => candidate.id === id)
        return artifact ? [artifact] : []
      })
    )
    if (
      artifacts.length === 0 ||
      artifactIds.length !== artifacts.length ||
      artifacts.some(
        (artifact) =>
          artifact.path.split(/[\\/]/).includes('.pending') ||
          (artifact.kind === 'managed-file' &&
            (artifact.versionId
              ? !confirmed.has(artifact.versionId)
              : !recovered.some(
                  (file) =>
                    !file.versionId && file.id === artifact.id && file.path === artifact.path
                )))
      )
    )
      continue
    const outcome = {
      kind: 'completed' as const,
      settledAt: Math.max(session.updatedAt, priorOutcome.settledAt, Date.now())
    }
    next = setTurnOutcome(next, prompt.id, outcome)
    // Completing historical Artifact repair cannot replace a newer turn's live state.
    if (
      !next.activeRun &&
      (next.runtimeTranscriptLastRun?.promptMessageId ?? latestOutcomePrompt(next)?.id) ===
        prompt.id
    )
      next = { ...next, ...legacySessionStateForOutcome(outcome, prompt.id) }
  }
  return next
}

class SessionPersistenceReconciliationOwner {
  private readonly onSessionCommitted: ((session: PersistedChatSession) => void) | undefined
  private readonly ownsPromptPreparation: ((session: PersistedChatSession) => boolean) | undefined
  private readonly repository: SessionReconciliationRepository
  private readonly fileIndex: SessionReconciliationFileIndex
  private readonly provenance: SessionReconciliationProvenance | undefined
  private readonly uploads: SessionUploadPersistence | undefined
  private readonly artifactStorage: ArtifactStorageReconciler | undefined
  private readonly permissionGrants: SessionPermissionGrantReconciliation | undefined

  constructor(options: SessionPersistenceReconciliationOwnerOptions) {
    this.onSessionCommitted = options.onSessionCommitted
    this.ownsPromptPreparation = options.ownsPromptPreparation
    this.repository = options.repository
    this.fileIndex = options.fileIndex
    this.provenance = options.provenance
    this.uploads = options.uploads
    this.artifactStorage = options.artifactStorage
    this.permissionGrants = options.permissionGrants
  }

  async retryArtifactFinalization(
    session: PersistedChatSession,
    request: { messageId: string; pendingPaths: string[]; artifactVersionIds?: string[] }
  ): Promise<PendingArtifactFinalizationRecovery | undefined> {
    if (!this.artifactStorage) return undefined

    const requestedRunIds = [
      ...new Set(request.pendingPaths.map((pendingPath) => basename(dirname(pendingPath))))
    ]
    const artifactRecovery = await this.artifactStorage.reconcileSession(
      session.projectId,
      session.id,
      session,
      {
        removeOrphanStaging: false,
        artifactRunIds: requestedRunIds,
        artifactVersionIds: request.artifactVersionIds
      }
    )
    const artifacts = (artifactRecovery?.recoveredMessageArtifacts ?? []).flatMap((recovery) =>
      recovery.messageId === request.messageId ? recovery.artifacts : []
    )
    const nativeFinalizationRunIds = artifactRecovery?.nativeFinalizationRunIds
    if (!nativeFinalizationRunIds) {
      if (artifacts.length > 0)
        await this.commitRecoveredArtifacts(session, request.messageId, artifacts)
      return artifacts.length > 0 ? { artifacts, nativeRunIds: [] } : undefined
    }

    const nativeRunIds = nativeFinalizationRunIds
    if (nativeRunIds.length === 0) return undefined

    const unresolvedRunIds = new Set(artifactRecovery?.unresolvedNativeFinalizationRunIds ?? [])
    if (nativeRunIds.some((runId) => unresolvedRunIds.has(runId))) {
      const invalidProofRunIds = new Set(
        artifactRecovery?.invalidProofNativeFinalizationRunIds ?? []
      )
      if (nativeRunIds.some((runId) => invalidProofRunIds.has(runId))) {
        throw Object.assign(new Error('Native Artifact finalization proof is invalid.'), {
          code: ARTIFACT_FINALIZATION_INVALID_PROOF
        })
      }
      throw new Error('Native Artifact finalization remains unresolved.')
    }

    const versionIds = new Set(
      artifacts.flatMap((artifact) => (artifact.versionId ? [artifact.versionId] : []))
    )
    if (request.artifactVersionIds?.some((id) => !versionIds.has(id)))
      throw new Error('Artifact finalization did not resolve all native Versions.')
    await this.commitRecoveredArtifacts(session, request.messageId, artifacts)
    return { artifacts, nativeRunIds }
  }

  async commitRecoveredArtifacts(
    session: PersistedChatSession,
    messageId: string,
    artifacts: ArtifactFile[],
    pendingPaths: readonly string[] = []
  ): Promise<void> {
    if (
      artifacts.some(
        (artifact) =>
          artifact.projectId !== session.projectId ||
          artifact.sessionId !== session.id ||
          (artifact.messageId !== undefined && artifact.messageId !== messageId)
      )
    )
      throw new Error('Artifact recovery changed its Session or Message owner.')
    const attached = attachRecoveredMessageArtifacts(session, [
      { messageId, artifacts, pendingPaths: [...pendingPaths] }
    ])
    const recovered = settleRecoveredArtifactOutcomes(
      attached,
      artifacts,
      await this.confirmPublishedVersions(attached),
      session
    )
    if (recovered === session) return
    const persisted = await saveSessionWithRevision(
      this.repository,
      recovered,
      sessionRevision(session)
    )
    this.onSessionCommitted?.(persisted)
    await this.provenance?.captureFinalizedMessages(persisted)
    await this.fileIndex.syncSession(persisted)
  }

  private async confirmPublishedVersions(session: PersistedChatSession): Promise<string[]> {
    if (!this.artifactStorage?.resolveVersionDescriptors) return []
    const failedPrompts = new Set(
      (session.conversationGraph?.messages ?? session.messages)
        .filter((message) => {
          const outcome = resolveTurnOutcome(session, message.id)
          return outcome?.kind === 'failed' && outcome.recovery === 'retry-artifact-publication'
        })
        .map(({ id }) => id)
    )
    const referencedIds = new Set(
      (session.conversationGraph?.messages ?? session.messages)
        .filter(
          (message) => message.responseToMessageId && failedPrompts.has(message.responseToMessageId)
        )
        .flatMap((message) => message.artifactIds ?? [])
    )
    const versionIds = [
      ...new Set(
        (session.artifacts ?? []).flatMap((artifact) =>
          referencedIds.has(artifact.id) && artifact.versionId ? [artifact.versionId] : []
        )
      )
    ]
    const published: string[] = []
    for (let offset = 0; offset < versionIds.length; offset += 100) {
      const descriptors = await this.artifactStorage.resolveVersionDescriptors({
        projectId: session.projectId,
        appSessionId: session.id,
        versionIds: versionIds.slice(offset, offset + 100)
      })
      published.push(
        ...descriptors
          .filter((descriptor) => descriptor.state === 'finalized' && descriptor.isPublished)
          .map(({ versionId }) => versionId)
      )
    }
    return published
  }

  async reconcileLoadedSessions(
    input: ReconcileLoadedSessionsInput
  ): Promise<ReconcileLoadedSessionsOutcome> {
    let result = input.result
    let sessions = result.sessions

    if (input.allowDestructiveCleanup && this.permissionGrants) {
      input.phase('reconcile-permission-grants')
      try {
        await this.permissionGrants.reconcileSessions(
          sessions.map((session) => ({ projectId: session.projectId, sessionId: session.id }))
        )
      } catch (error) {
        // Permission scope matching remains fail-closed and a later process startup retries cleanup.
        input.onPermissionFailure(error)
      }
    }

    input.phase('reconcile-derived-state')
    try {
      const provenance = this.provenance
      if (provenance?.recoverLegacySessionGraph && this.repository.saveSessionWithBindingRepair) {
        for (let index = 0; index < sessions.length; index += 1) {
          const session = sessions[index]
          const repaired = await provenance.recoverLegacySessionGraph(session)
          if (!repaired) continue
          const persisted = await this.repository.saveSessionWithBindingRepair(
            repaired,
            sessionRevision(session)
          )
          sessions = sessions.map((candidate, candidateIndex) =>
            candidateIndex === index ? persisted : candidate
          )
          result = { ...result, sessions }
        }
      }
      const splitProvenance =
        provenance?.reconcileSessionCleanup && provenance.reconcileMessageSnapshots
          ? {
              reconcileSessionCleanup: provenance.reconcileSessionCleanup.bind(provenance),
              reconcileMessageSnapshots: provenance.reconcileMessageSnapshots.bind(provenance)
            }
          : undefined
      await splitProvenance?.reconcileSessionCleanup(sessions)

      if (this.uploads) {
        for (let index = 0; index < sessions.length; index += 1) {
          const session = sessions[index]
          if (hasLegacySessionUpload(session)) {
            // Publish immutable identities without consuming a source, then persist them before the
            // destructive startup pass can remove the legacy copy.
            const upgradedSession = await this.uploads.upgradeLegacySessionUploads(session, {
              mode: 'live-save'
            })
            sessions = sessions.map((candidate, candidateIndex) =>
              candidateIndex === index ? upgradedSession : candidate
            )
            result = { ...result, sessions }
            const persisted = await saveSessionWithRevision(this.repository, upgradedSession)
            sessions = sessions.map((candidate, candidateIndex) =>
              candidateIndex === index ? persisted : candidate
            )
            result = { ...result, sessions }
            if (input.allowDestructiveCleanup) {
              await this.uploads.upgradeLegacySessionUploads(persisted, {
                mode: 'reconcile'
              })
            }
          } else {
            await this.uploads.upgradeLegacySessionUploads(session, {
              mode: input.allowDestructiveCleanup ? 'reconcile' : 'live-save'
            })
          }
        }
      }

      const projectReconciliations = new Map<string, ArtifactProjectReconciliationSnapshot>()
      if (this.artifactStorage) {
        for (const projectId of new Set(sessions.map((session) => session.projectId))) {
          projectReconciliations.set(
            projectId,
            await this.artifactStorage.prepareProjectReconciliation(projectId)
          )
        }
      }
      for (let index = 0; index < sessions.length; index += 1) {
        let session = sessions[index]
        const authority =
          session.promptPreparation || session.resumeRecovery?.cause === 'app-restart'
            ? await this.repository.loadSessionWithDiagnostics?.(session.projectId, session.id, {
                preserveRuntimeState: true
              })
            : undefined
        if (authority?.status === 'found' && !this.ownsPromptPreparation?.(authority.session))
          session = recordRestartTurnOutcome(session, authority.session)
        const artifactRecovery = await this.artifactStorage?.reconcileSession(
          session.projectId,
          session.id,
          session,
          {
            removeOrphanStaging: input.allowDestructiveCleanup,
            projectReconciliation: projectReconciliations.get(session.projectId)!
          }
        )
        const attachedSession = attachRecoveredMessageArtifacts(
          session,
          artifactRecovery?.recoveredMessageArtifacts ?? []
        )
        const settledSession = settleRecoveredArtifactOutcomes(
          attachedSession,
          (artifactRecovery?.recoveredMessageArtifacts ?? []).flatMap(({ artifacts }) => artifacts),
          await this.confirmPublishedVersions(attachedSession),
          session
        )
        const recoveredSession = repairHistoricalArtifactAliases(settledSession, {
          advanceFilesRevision: attachedSession === session
        })
        if (recoveredSession !== sessions[index]) {
          // Capture immutable Message evidence before JSON so a failure leaves an attachment witness.
          sessions = sessions.map((candidate, candidateIndex) =>
            candidateIndex === index ? recoveredSession : candidate
          )
          result = { ...result, sessions }
          await this.provenance?.captureFinalizedMessages(recoveredSession)
          const persisted = await saveSessionWithRevision(this.repository, recoveredSession)
          sessions = sessions.map((candidate, candidateIndex) =>
            candidateIndex === index ? persisted : candidate
          )
          result = { ...result, sessions }
        }
      }
      // Message snapshot repair needs the authoritative Artifact attachments recovered above;
      // otherwise a ready snapshot can be compared against incomplete Session JSON and stay
      // unavailable even after the Session is repaired later in this same startup pass.
      if (splitProvenance) await splitProvenance.reconcileMessageSnapshots(sessions)
      else await this.provenance?.reconcileSessionDeletions(sessions)
      // Restore active owners before scan-order-dependent sync offers canonical rows elsewhere.
      await this.fileIndex.reconcileActiveSessions(sessions)
      for (const session of sessions) {
        await this.fileIndex.syncSession(session)
      }
    } catch (failure) {
      return { status: 'degraded', result, failure }
    }

    return { status: 'ready', result }
  }

  async repairFileProjection(sessions: PersistedChatSession[]): Promise<void> {
    const syncErrors = new Map<string, unknown>()
    for (const session of sessions) {
      try {
        await this.fileIndex.syncSession(session, { force: true })
      } catch (error) {
        syncErrors.set(sessionKey(session.projectId, session.id), error)
      }
    }

    let reconciliationSucceeded = false
    let reconciliationError: unknown
    try {
      await this.fileIndex.reconcileActiveSessions(sessions)
      reconciliationSucceeded = true
    } catch (error) {
      reconciliationError = error
    }

    if (reconciliationSucceeded) {
      for (const session of sessions) {
        const key = sessionKey(session.projectId, session.id)
        try {
          await this.fileIndex.syncSession(session, { force: true })
          syncErrors.delete(key)
        } catch (error) {
          syncErrors.set(key, error)
        }
      }
    }

    if (reconciliationError) throw reconciliationError
    const finalSyncError = syncErrors.values().next().value
    if (finalSyncError) throw finalSyncError
  }
}

const sessionKey = (projectId: string, sessionId: string): string => `${projectId}:${sessionId}`

export { SessionPersistenceReconciliationOwner }
export type {
  ArtifactStorageReconciler,
  PendingArtifactFinalizationRecovery,
  SessionPermissionGrantReconciliation,
  SessionUploadPersistence
}
