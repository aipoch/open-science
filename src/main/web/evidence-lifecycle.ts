import type { PersistedChatSession, PersistedToolActivity } from '../../shared/session-persistence'
import {
  resolveActiveConversationActivities,
  resolveActiveConversationMessages
} from '../../shared/conversation-graph'
import { readWebResultEnvelope } from '../../shared/web-tools'
import { SessionProjectionAfterCommitError } from '../session-persistence/save-session'
import { WebSnapshotStore, webTextHash, type PendingWebInheritance } from './snapshot-store'
import { WebToolError } from './errors'

export const webEvidenceScope = (projectId: string, sessionId: string, branchId?: string): string =>
  JSON.stringify(branchId === undefined ? [projectId, sessionId] : [projectId, sessionId, branchId])
const activeBranchId = (session: PersistedChatSession): string | undefined =>
  session.conversationGraph?.frames.find(
    (frame) => frame.id === session.conversationGraph?.activeFrameId
  )?.activeBranchId
const scopeFor = (session: PersistedChatSession): string =>
  webEvidenceScope(session.projectId, session.id, activeBranchId(session))
type WebBranchChange = { projectId: string; sessionId: string; branchId?: string }
const branchListeners = new Set<(change: WebBranchChange) => void>()
export const subscribeWebBranchChanges = (
  listener: (change: WebBranchChange) => void
): (() => void) => {
  branchListeners.add(listener)
  return () => {
    branchListeners.delete(listener)
  }
}
const selectBranch = (
  session: PersistedChatSession,
  branchId: string,
  frameId?: string
): PersistedChatSession => {
  const graph = session.conversationGraph
  const branch = graph?.branches.find(
    (item) => item.id === branchId && (frameId === undefined || item.agentFrameId === frameId)
  )
  if (!graph || !branch) throw new WebToolError('EVIDENCE_UNAVAILABLE')
  const selected = {
    ...graph,
    activeFrameId: branch.agentFrameId,
    frames: graph.frames.map((frame) =>
      frame.id === branch.agentFrameId ? { ...frame, activeBranchId: branchId } : frame
    )
  }
  return {
    ...session,
    conversationGraph: selected,
    messages: resolveActiveConversationMessages(selected),
    activities: resolveActiveConversationActivities(selected).activities
  }
}
type EvidenceRecord = { snapshotId: string; fingerprint: string }
const records = (activities: readonly PersistedToolActivity[]): EvidenceRecord[] =>
  activities.flatMap((activity) => {
    if (
      activity.appOwned !== true ||
      !activity.executionInvocationId ||
      activity.status !== 'completed' ||
      activity.toolDisposition ||
      !['mcp__open_science_web__web_fetch', 'mcp__open-science-web__web_fetch'].includes(
        activity.providerToolName ?? ''
      )
    )
      return []
    const candidates: unknown[] = [activity.rawOutput]
    for (const block of activity.toolContent ?? []) {
      if (
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'content' &&
        'content' in block
      ) {
        const content = block.content as { type?: string; text?: string }
        if (content?.type === 'text') candidates.push(content.text)
      }
    }
    for (const candidate of candidates) {
      const result = readWebResultEnvelope(candidate)
      if (
        result?.operation === 'fetch' &&
        result.status === 'ok' &&
        result.document &&
        result.invocation_id === activity.executionInvocationId
      ) {
        return [
          {
            snapshotId: result.document.snapshot_id,
            fingerprint: webTextHash(JSON.stringify(result))
          }
        ]
      }
    }
    return []
  })
const childRecords = (child: PersistedChatSession): EvidenceRecord[] =>
  records(
    child.conversationGraph
      ? resolveActiveConversationActivities(child.conversationGraph).activities
      : (child.activities ?? [])
  )
const inheritanceFingerprint = (child: PersistedChatSession, ids: ReadonlySet<string>): string => {
  const source = child.branchSource
  return webTextHash(
    JSON.stringify([
      scopeFor(child),
      source?.sessionId,
      source?.agentFrameId ?? null,
      source?.messageBranchId ?? null,
      source?.headMessageId ?? null,
      [
        ...new Set(
          childRecords(child)
            .filter((record) => ids.has(record.snapshotId))
            .map((record) => `${record.snapshotId}:${record.fingerprint}`)
        )
      ].sort()
    ])
  )
}

/** Validates inherited evidence against the authoritative parent's selected branch and cutoff. */
export const inheritedWebSnapshotIds = (
  parent: PersistedChatSession,
  child: PersistedChatSession
): string[] => {
  const source = child.branchSource
  if (
    !source ||
    source.sessionId !== parent.id ||
    child.projectId !== parent.projectId ||
    child.packageOrigin ||
    parent.packageOrigin
  )
    return []
  let messages = parent.messages
  let activities = parent.activities ?? []
  if (parent.conversationGraph) {
    const graph = parent.conversationGraph
    const frameId = source.agentFrameId ?? graph.activeFrameId
    const frame = graph.frames.find((item) => item.id === frameId)
    if (!frame) throw new WebToolError('EVIDENCE_UNAVAILABLE')
    const branchId = source.messageBranchId ?? frame.activeBranchId
    const selected = selectBranch(parent, branchId, frameId)
    messages = selected.messages
    activities = selected.activities ?? []
  }
  const head = source.headMessageId
    ? messages.find((message) => message.id === source.headMessageId)
    : messages.at(-1)
  if (source.headMessageId && !head) throw new WebToolError('EVIDENCE_UNAVAILABLE')
  const cutoff = head?.completedAt ?? head?.updatedAt ?? head?.createdAt
  const prefixPrompts = new Set(
    messages
      .slice(0, head ? messages.indexOf(head) + 1 : 0)
      .filter((message) => message.role === 'user')
      .map((message) => message.id)
  )
  const promptByActivity = new Map(
    parent.conversationGraph?.activities.map((activity) => [
      activity.id,
      activity.promptMessageId
    ]) ?? []
  )
  const prefix =
    head && cutoff !== undefined
      ? activities.filter((activity) => {
          const prompt = activity.promptMessageId ?? promptByActivity.get(activity.id)
          return (
            (!prompt || prefixPrompts.has(prompt)) &&
            activity.createdAt <= cutoff &&
            activity.updatedAt <= cutoff
          )
        })
      : []
  const allowed = new Set(
    records(prefix).map((record) => `${record.snapshotId}:${record.fingerprint}`)
  )
  return [
    ...new Set(
      childRecords(child)
        .filter((record) => allowed.has(`${record.snapshotId}:${record.fingerprint}`))
        .map((record) => record.snapshotId)
    )
  ]
}

export type WebEvidenceSessionReader = (
  projectId: string,
  sessionId: string
) => Promise<PersistedChatSession | undefined>
const stripInheritedRetry = (child: PersistedChatSession): void => {
  const strip = <T extends PersistedToolActivity>(activity: T): T => {
    if (!activity.webInvocation?.retryEligible) return activity
    const { retryEligible: _retryEligible, ...metadata } = activity.webInvocation
    void _retryEligible
    return { ...activity, webInvocation: metadata }
  }
  if (child.activities) child.activities = child.activities.map(strip)
  if (child.conversationGraph)
    child.conversationGraph = {
      ...child.conversationGraph,
      activities: child.conversationGraph.activities.map(strip)
    }
}
export class WebEvidenceLifecycle {
  private readonly stagedScopes = new Map<string, Set<string>>()
  constructor(
    readonly store: WebSnapshotStore,
    private readonly loadSession: WebEvidenceSessionReader,
    private readonly deleteInvocations?: (binding: {
      projectId: string
      sessionId: string
    }) => Promise<void>,
    private readonly invocationSessions?: () => Promise<
      Array<{ projectId: string; sessionId: string }>
    >
  ) {}
  private forgetStaged(child: PersistedChatSession, scope: string): void {
    const key = webEvidenceScope(child.projectId, child.id)
    const staged = this.stagedScopes.get(key)
    staged?.delete(scope)
    if (staged?.size === 0) this.stagedScopes.delete(key)
  }

  private notifyBranchChanged(
    previous: PersistedChatSession | undefined,
    saved: PersistedChatSession
  ): void {
    if (!previous || activeBranchId(previous) === activeBranchId(saved)) return
    for (const listener of branchListeners) {
      try {
        listener({
          projectId: saved.projectId,
          sessionId: saved.id,
          branchId: activeBranchId(saved)
        })
      } catch {
        /* Observers cannot undo a durable Session publication. */
      }
    }
  }

  async prepareFork(
    parent: PersistedChatSession,
    child: PersistedChatSession,
    sourceBranchId?: string
  ): Promise<void> {
    if (parent.id !== child.id) stripInheritedRetry(child)
    const ids = inheritedWebSnapshotIds(parent, child)
    if (!ids.length) return
    const sourceScope = webEvidenceScope(
      parent.projectId,
      parent.id,
      sourceBranchId ?? child.branchSource?.messageBranchId ?? activeBranchId(parent)
    )
    await this.store.prepareInheritance(
      sourceScope,
      scopeFor(child),
      ids,
      inheritanceFingerprint(child, new Set(ids)),
      webEvidenceScope(parent.projectId, parent.id)
    )
    const key = webEvidenceScope(child.projectId, child.id)
    const staged = this.stagedScopes.get(key) ?? new Set<string>()
    staged.add(scopeFor(child))
    this.stagedScopes.set(key, staged)
  }

  private async pending(
    child: PersistedChatSession,
    extraScope?: string
  ): Promise<PendingWebInheritance[]> {
    const base = webEvidenceScope(child.projectId, child.id)
    const scopes = [
      base,
      ...(child.conversationGraph?.branches.map((branch) =>
        webEvidenceScope(child.projectId, child.id, branch.id)
      ) ?? []),
      ...(this.stagedScopes.get(base) ?? []),
      ...(extraScope ? [extraScope] : [])
    ]
    return (await this.store.pendingInheritances(scopes)).filter((intent) => {
      const identity = JSON.parse(intent.childScope) as unknown[]
      return identity[0] === child.projectId && identity[1] === child.id
    })
  }

  private pendingView(
    child: PersistedChatSession,
    pending: PendingWebInheritance
  ): PersistedChatSession | undefined {
    const identity = JSON.parse(pending.childScope) as string[]
    const parent = JSON.parse(pending.parentScope) as string[]
    if (
      identity[2] &&
      !child.conversationGraph?.branches.some((branch) => branch.id === identity[2])
    )
      return undefined
    const view = identity[2] ? selectBranch(child, identity[2]) : child
    const branch = view.conversationGraph?.branches.find((item) => item.id === identity[2])
    if (
      parent.length === 3 &&
      parent[0] === child.projectId &&
      parent[1] === child.id &&
      branch?.parentBranchId
    ) {
      return {
        ...view,
        branchSource: {
          sessionId: child.id,
          agentFrameId: branch.agentFrameId,
          messageBranchId: branch.parentBranchId,
          ...(branch.forkMessageId ? { headMessageId: branch.forkMessageId } : {})
        }
      }
    }
    return view
  }

  async confirmPublication(child: PersistedChatSession, extraScope?: string): Promise<void> {
    for (const pending of await this.pending(child, extraScope)) {
      const view = this.pendingView(child, pending)
      if (!view) {
        await this.store.abortInheritance(pending.childScope, pending.fingerprint)
        this.forgetStaged(child, pending.childScope)
        continue
      }
      const fingerprint = inheritanceFingerprint(
        view,
        new Set(pending.references.map((reference) => reference.snapshotId))
      )
      if (fingerprint !== pending.fingerprint) throw new WebToolError('EVIDENCE_UNAVAILABLE')
      await this.store.finishInheritance(pending.childScope, fingerprint)
      this.forgetStaged(child, pending.childScope)
    }
  }

  async abortFork(child: PersistedChatSession): Promise<void> {
    for (const pending of await this.pending(child)) {
      await this.store.abortInheritance(pending.childScope, pending.fingerprint)
      this.forgetStaged(child, pending.childScope)
    }
  }

  async withSessionPublication(
    child: PersistedChatSession,
    save: () => Promise<PersistedChatSession>
  ): Promise<PersistedChatSession> {
    return this.withCanonicalPublication(
      child,
      await this.loadSession(child.projectId, child.id),
      save
    )
  }

  async withCanonicalPublication(
    child: PersistedChatSession,
    previous: PersistedChatSession | undefined,
    save: () => Promise<PersistedChatSession>
  ): Promise<PersistedChatSession> {
    try {
      if (!previous && child.branchSource) {
        const parent = await this.loadSession(child.projectId, child.branchSource.sessionId)
        if (!parent) throw new WebToolError('EVIDENCE_UNAVAILABLE')
        await this.prepareFork(parent, child)
      } else if (previous?.conversationGraph && child.conversationGraph) {
        const existing = new Set(previous.conversationGraph.branches.map((branch) => branch.id))
        for (const branch of child.conversationGraph.branches) {
          if (existing.has(branch.id) || !branch.parentBranchId) continue
          let ancestor = branch.parentBranchId
          const visited = new Set<string>()
          while (!existing.has(ancestor)) {
            if (visited.has(ancestor)) throw new WebToolError('EVIDENCE_UNAVAILABLE')
            visited.add(ancestor)
            const parentId = child.conversationGraph.branches.find(
              (entry) => entry.id === ancestor
            )?.parentBranchId
            if (!parentId) throw new WebToolError('EVIDENCE_UNAVAILABLE')
            ancestor = parentId
          }
          const parent = selectBranch(child, branch.parentBranchId)
          const view = selectBranch(child, branch.id)
          await this.prepareFork(
            parent,
            {
              ...view,
              branchSource: {
                sessionId: previous.id,
                agentFrameId: branch.agentFrameId,
                messageBranchId: branch.parentBranchId,
                ...(branch.forkMessageId ? { headMessageId: branch.forkMessageId } : {})
              }
            },
            ancestor
          )
        }
      }
    } catch (error) {
      await this.abortFork(child)
      throw error
    }
    let saved: PersistedChatSession
    try {
      saved = await save()
    } catch (error) {
      const durable =
        error instanceof SessionProjectionAfterCommitError
          ? error.committedSession
          : await this.loadSession(child.projectId, child.id)
      if (durable) {
        this.notifyBranchChanged(previous, durable)
        await this.confirmPublication(durable)
      } else await this.abortFork(child)
      throw error
    }
    this.notifyBranchChanged(previous, saved)
    try {
      await this.confirmPublication(saved)
    } catch (error) {
      throw new SessionProjectionAfterCommitError(saved, error)
    }
    return saved
  }

  async recover(): Promise<void> {
    for (const pending of await this.store.pendingInheritances()) {
      let identity: unknown
      try {
        identity = JSON.parse(pending.childScope)
      } catch {
        throw new WebToolError('EVIDENCE_UNAVAILABLE')
      }
      if (
        !Array.isArray(identity) ||
        ![2, 3].includes(identity.length) ||
        !identity.every((part) => typeof part === 'string')
      )
        throw new WebToolError('EVIDENCE_UNAVAILABLE')
      const child = await this.loadSession(identity[0], identity[1])
      if (child) await this.confirmPublication(child, pending.childScope)
      else await this.store.abortInheritance(pending.childScope, pending.fingerprint)
    }
    const sessions = new Map<string, { projectId: string; sessionId: string }>()
    for (const binding of [
      ...(await this.store.ownedSessions()),
      ...((await this.invocationSessions?.()) ?? [])
    ])
      sessions.set(webEvidenceScope(binding.projectId, binding.sessionId), binding)
    for (const binding of sessions.values()) {
      if (!(await this.loadSession(binding.projectId, binding.sessionId)))
        await this.releaseSession(binding.projectId, binding.sessionId)
    }
    await this.store.recoverDeletions()
    for (const binding of await this.store.deletedSessions())
      await this.deleteInvocations?.(binding)
  }

  async releaseSession(projectId: string, sessionId: string): Promise<void> {
    const outcomes = await Promise.allSettled([
      this.store.releaseSessionTree(projectId, sessionId),
      this.deleteInvocations?.({ projectId, sessionId })
    ])
    const failures = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    )
    if (failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'Web evidence cleanup is incomplete.'
      )
  }

  async ensureBranchOwnership(session: PersistedChatSession, branchId: string): Promise<void> {
    if (session.packageOrigin) return
    const view = selectBranch(session, branchId)
    const graph = view.conversationGraph!
    const headMessageId = view.messages.at(-1)?.id
    const proof = {
      ...view,
      branchSource: {
        sessionId: session.id,
        agentFrameId: graph.activeFrameId,
        messageBranchId: branchId,
        ...(headMessageId ? { headMessageId } : {})
      }
    }
    const ids: string[] = []
    const target = webEvidenceScope(session.projectId, session.id, branchId)
    const legacy = webEvidenceScope(session.projectId, session.id)
    for (const id of inheritedWebSnapshotIds(view, proof)) {
      if (
        !(await this.store.hasCommittedReference(target, id)) &&
        (await this.store.hasCommittedReference(legacy, id))
      )
        ids.push(id)
    }
    if (!ids.length) return
    const fingerprint = inheritanceFingerprint(view, new Set(ids))
    await this.store.prepareInheritance(legacy, target, ids, fingerprint)
    await this.store.finishInheritance(target, fingerprint)
  }
}
