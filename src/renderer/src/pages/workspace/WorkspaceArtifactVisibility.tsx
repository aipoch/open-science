import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { flushSessionPersistence } from '@/lib/session-persistence/session-persistence'
import type { ChatSession } from '@/stores/session-store'
import { MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS } from '../../../../shared/artifacts'
import {
  createArtifactVersionLocator,
  type ArtifactVersionDescriptor
} from '../../../../shared/artifact-provenance'
import { projectRootArtifactVisibility } from '../../../../shared/artifact-visibility'
import { resolveProjectId } from '../../../../shared/project-scope'
import { resolveTurnTerminalAgentMessageIds } from './workspace-conversation-items'

type MessageArtifact = NonNullable<ChatSession['artifacts']>[number] & {
  resolvedProjectId?: string
  resolvedSessionId?: string
}

const getMessageArtifacts = (
  artifacts: ChatSession['artifacts'],
  message: ChatSession['messages'][number],
  resolvedArtifactsByVersionId?: ReadonlyMap<string, MessageArtifact | undefined>
): MessageArtifact[] => {
  if (!message.artifactIds) return []
  const artifactsById = new Map(
    (artifacts ?? []).map((artifact) => [artifact.id, artifact as MessageArtifact])
  )
  const artifactsByLogicalId = new Map<string, MessageArtifact>()
  for (const artifactId of message.artifactIds) {
    const stored = artifactsById.get(artifactId)
    const artifact =
      stored?.versionId && stored.isPublished === undefined
        ? (resolvedArtifactsByVersionId?.get(artifactId) ?? stored)
        : (stored ?? resolvedArtifactsByVersionId?.get(artifactId))
    if (!artifact) continue
    const logicalId = artifact.versionId
      ? `version:${artifact.versionId}`
      : `artifact:${artifact.id}`
    const current = artifactsByLogicalId.get(logicalId)
    const isNativeVersion = Boolean(artifact.versionId && artifact.id === artifact.versionId)
    const currentIsNativeVersion = Boolean(current?.versionId && current.id === current.versionId)
    if (!current || (isNativeVersion && !currentIsNativeVersion)) {
      artifactsByLogicalId.set(logicalId, artifact)
    }
  }
  return [...artifactsByLogicalId.values()]
}

const resolveMessageArtifactScope = (
  artifact: NonNullable<ChatSession['artifacts']>[number],
  projectId: string | undefined,
  sessionId: string | undefined
): MessageArtifact => {
  const messageArtifact = artifact as MessageArtifact
  const resolvedProjectId = messageArtifact.resolvedProjectId ?? projectId
  const resolvedSessionId = messageArtifact.resolvedSessionId ?? sessionId
  if (
    resolvedProjectId === messageArtifact.resolvedProjectId &&
    resolvedSessionId === messageArtifact.resolvedSessionId
  ) {
    return messageArtifact
  }
  return {
    ...messageArtifact,
    ...(resolvedProjectId ? { resolvedProjectId } : {}),
    ...(resolvedSessionId ? { resolvedSessionId } : {})
  }
}

const isSafeVersionId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)

const toResolvedMessageArtifact = (descriptor: ArtifactVersionDescriptor): MessageArtifact => ({
  id: descriptor.versionId,
  artifactId: descriptor.artifactId,
  versionId: descriptor.versionId,
  versionNumber: descriptor.versionNumber,
  isPublished: descriptor.isPublished === true,
  kind: 'managed-file',
  path: createArtifactVersionLocator({
    projectId: resolveProjectId(descriptor),
    appSessionId: descriptor.sessionId,
    artifactId: descriptor.artifactId,
    versionId: descriptor.versionId
  }),
  name: descriptor.name,
  mimeType: descriptor.mimeType,
  size: descriptor.size,
  mtimeMs: descriptor.mtimeMs,
  sha256: descriptor.checksum,
  resolvedProjectId: resolveProjectId(descriptor),
  resolvedSessionId: descriptor.sessionId
})

const useHistoricalArtifactDescriptors = (
  sessionId: string | undefined,
  projectId: string | undefined,
  messages: ChatSession['messages'] | undefined,
  artifacts: ChatSession['artifacts'],
  projectedVersionIds: readonly string[]
): ReadonlyMap<string, MessageArtifact | undefined> => {
  const resolvedRef = useRef<{
    sessionId: string | undefined
    artifactsByVersionId: Map<string, MessageArtifact | undefined>
  }>({ sessionId: undefined, artifactsByVersionId: new Map() })
  const [resolved, setResolved] = useState<{
    sessionId: string | undefined
    artifactsByVersionId: ReadonlyMap<string, MessageArtifact | undefined>
  }>({ sessionId: undefined, artifactsByVersionId: new Map() })
  const [retryToken, setRetryToken] = useState(0)
  const retriedVersionIdsRef = useRef(new Set<string>())
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (resolvedRef.current.sessionId !== sessionId) {
      resolvedRef.current = { sessionId, artifactsByVersionId: new Map() }
      retriedVersionIdsRef.current.clear()
      setResolved(resolvedRef.current)
    }
    if (
      sessionId === undefined ||
      projectId === undefined ||
      messages === undefined ||
      typeof window.api?.artifacts?.resolveVersionDescriptors !== 'function'
    ) {
      return
    }
    const cache = resolvedRef.current.artifactsByVersionId
    const storedArtifactIds = new Set(
      (artifacts ?? [])
        .filter((artifact) => !artifact.versionId || artifact.isPublished !== undefined)
        .map((artifact) => artifact.id)
    )
    const unresolvedVersionIds = [
      ...new Set([
        ...messages.flatMap((message) => message.artifactIds ?? []),
        ...projectedVersionIds
      ])
    ].filter(
      (versionId) =>
        !storedArtifactIds.has(versionId) && !cache.has(versionId) && isSafeVersionId(versionId)
    )
    if (unresolvedVersionIds.length === 0) return
    for (const versionId of unresolvedVersionIds) cache.set(versionId, undefined)

    void (async () => {
      for (
        let index = 0;
        index < unresolvedVersionIds.length;
        index += MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS
      ) {
        const versionIds = unresolvedVersionIds.slice(
          index,
          index + MAX_ARTIFACT_VERSION_DESCRIPTOR_IDS
        )
        try {
          const descriptors = await window.api.artifacts.resolveVersionDescriptors({
            projectId,
            appSessionId: sessionId,
            versionIds
          })
          for (const descriptor of descriptors) {
            cache.set(descriptor.versionId, toResolvedMessageArtifact(descriptor))
          }
        } catch {
          let shouldRetry = false
          for (const versionId of versionIds) {
            cache.delete(versionId)
            if (!retriedVersionIdsRef.current.has(versionId)) {
              retriedVersionIdsRef.current.add(versionId)
              shouldRetry = true
            }
          }
          if (shouldRetry) {
            await flushSessionPersistence()
            if (
              mountedRef.current &&
              resolvedRef.current.sessionId === sessionId &&
              resolvedRef.current.artifactsByVersionId === cache
            ) {
              setRetryToken((token) => token + 1)
            }
          }
        }
      }
      if (
        mountedRef.current &&
        resolvedRef.current.sessionId === sessionId &&
        resolvedRef.current.artifactsByVersionId === cache
      ) {
        setResolved({ sessionId, artifactsByVersionId: new Map(cache) })
      }
    })()
  }, [artifacts, messages, projectId, projectedVersionIds, retryToken, sessionId])

  return resolved.sessionId === sessionId ? resolved.artifactsByVersionId : new Map()
}

const useWorkspaceArtifactVisibility = (
  activeSession: ChatSession | undefined
): Readonly<{
  artifactsForMessage(message: ChatSession['messages'][number]): MessageArtifact[]
}> => {
  const sessionId = activeSession?.id
  const projectId = activeSession?.projectId
  const messages = activeSession?.messages
  const artifacts = activeSession?.artifacts
  const graph = activeSession?.conversationGraph
  const scopedArtifacts = useMemo(
    () => artifacts?.map((artifact) => resolveMessageArtifactScope(artifact, projectId, sessionId)),
    [artifacts, projectId, sessionId]
  )
  const projection = useMemo(() => {
    if (!graph || graph.activeFrameId !== graph.rootFrameId) return undefined
    const rootFrame = graph.frames.find(({ id }) => id === graph.rootFrameId)
    return rootFrame
      ? projectRootArtifactVisibility({ conversationGraph: graph }, rootFrame.activeBranchId)
      : undefined
  }, [graph])
  const projectedVersionIds = useMemo(
    () => projection?.placements.map(({ artifactVersionId }) => artifactVersionId) ?? [],
    [projection]
  )
  const projectedArtifactVersionIdsByRootMessageId = useMemo(() => {
    const byRootMessageId = new Map<string, string[]>()
    for (const placement of projection?.placements ?? []) {
      const versionIds = byRootMessageId.get(placement.rootMessageId)
      if (versionIds) versionIds.push(placement.artifactVersionId)
      else byRootMessageId.set(placement.rootMessageId, [placement.artifactVersionId])
    }
    return byRootMessageId
  }, [projection])
  // The terminal agent fragment of each turn is the only place projected child Versions render,
  // mirroring how main-agent artifacts attach to the turn's final assistant message.
  const terminalAgentMessageIds = useMemo(
    () => resolveTurnTerminalAgentMessageIds(messages ?? []),
    [messages]
  )
  const historicalArtifacts = useHistoricalArtifactDescriptors(
    sessionId,
    projectId,
    messages,
    scopedArtifacts,
    projectedVersionIds
  )
  const artifactsForMessage = useCallback(
    (message: ChatSession['messages'][number]) => {
      if (sessionId === undefined) return []
      const projectedVersionIdsForTurn =
        message.role === 'agent' &&
        message.responseToMessageId &&
        terminalAgentMessageIds.has(message.id)
          ? projectedArtifactVersionIdsByRootMessageId.get(message.responseToMessageId)
          : undefined
      if (!projectedVersionIdsForTurn || projectedVersionIdsForTurn.length === 0) {
        return getMessageArtifacts(scopedArtifacts, message, historicalArtifacts)
      }
      return getMessageArtifacts(
        scopedArtifacts,
        {
          ...message,
          artifactIds: [...(message.artifactIds ?? []), ...projectedVersionIdsForTurn]
        },
        historicalArtifacts
      )
    },
    [
      historicalArtifacts,
      projectedArtifactVersionIdsByRootMessageId,
      scopedArtifacts,
      sessionId,
      terminalAgentMessageIds
    ]
  )
  return { artifactsForMessage }
}

export { useWorkspaceArtifactVisibility }
export type { MessageArtifact }
