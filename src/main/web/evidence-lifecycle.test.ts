import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PersistedChatSession,
  PersistedToolActivity,
  PersistedChatMessage
} from '../../shared/session-persistence'
import {
  createLinearConversationGraph,
  forkConversationAfterActivity,
  forkEditedConversationMessage,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages
} from '../../shared/conversation-graph'
import { WebService } from './service'
import { WebSnapshotStore, webTextHash } from './snapshot-store'
import {
  WebEvidenceLifecycle,
  inheritedWebSnapshotIds,
  subscribeWebBranchChanges,
  webEvidenceScope
} from './evidence-lifecycle'
import type { WebResult } from '../../shared/web-tools'
import { SessionProjectionAfterCommitError } from '../session-persistence/save-session'
import { WebInvocationStore, type WebInvocationRecord } from './invocation-store'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const message = (id: string, role: 'user' | 'agent', at: number): PersistedChatMessage => ({
  id,
  role,
  content: id,
  status: 'complete',
  eventIds: [],
  createdAt: at,
  updatedAt: at,
  ...(role === 'agent' ? { completedAt: at } : {})
})
const session = (id: string): PersistedChatSession => ({
  id,
  projectId: 'project',
  title: id,
  cwd: '',
  status: 'idle',
  createdAt: 1,
  updatedAt: 50,
  messages: [message('u1', 'user', 10), message('a1', 'agent', 50)],
  activities: []
})
type Fixture = {
  root: string
  store: WebSnapshotStore
  service: WebService
  lifecycle: WebEvidenceLifecycle
  sessions: Map<string, PersistedChatSession>
  network: string[]
  evidence(
    parent: PersistedChatSession,
    label?: string,
    scope?: string
  ): Promise<{ result: WebResult; activity: PersistedToolActivity }>
}
const fixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), 'web-branch-'))
  roots.push(root)
  const store = new WebSnapshotStore(root),
    sessions = new Map<string, PersistedChatSession>(),
    network: string[] = []
  const service = new WebService({
    store,
    transport: async (url) => {
      network.push(url)
      return {
        body: Buffer.from('Immutable page evidence with a remaining fragment.'),
        contentType: 'text/plain',
        finalUrl: url
      }
    }
  })
  const lifecycle = new WebEvidenceLifecycle(store, async (_project, id) => sessions.get(id))
  return {
    root,
    store,
    service,
    sessions,
    network,
    lifecycle,
    evidence: async (
      parent,
      label = 'first',
      scope = webEvidenceScope(parent.projectId, parent.id)
    ) => {
      const result = await service.fetch(
        scope,
        { url: `https://example.org/${label}`, max_chars: 5 },
        { invocationId: `invocation-${label}` }
      )
      expect(result.status).toBe('ok')
      await service.commitSnapshot(scope, result.document!.snapshot_id)
      const activity: PersistedToolActivity = {
        id: `activity-${label}`,
        kind: 'tool',
        title: 'web_fetch',
        status: 'completed',
        appOwned: true,
        executionInvocationId: result.invocation_id,
        providerToolName: 'mcp__open_science_web__web_fetch',
        sortIndex: 1,
        eventIds: [],
        createdAt: 20,
        updatedAt: 30,
        promptMessageId: 'u1',
        rawOutput: result
      }
      return { result, activity }
    }
  }
}
const childOf = (parent: PersistedChatSession, id = 'child'): PersistedChatSession => ({
  ...structuredClone(parent),
  id,
  branchSource: { sessionId: parent.id, headMessageId: 'a1' }
})
const continuation = (result: WebResult): { snapshot_id: string; cursor: string } => ({
  snapshot_id: result.document!.snapshot_id,
  cursor: result.document!.next_cursor!
})

describe('branch-owned immutable web evidence', () => {
  it('honors an activity cutoff inside the same prompt even when both results predate the answer', async () => {
    const f = await fixture(),
      parent = session('parent')
    const graph = createLinearConversationGraph({
      sessionId: parent.id,
      messages: parent.messages,
      createdAt: 1,
      updatedAt: 50
    })
    const sourceBranch = graph.frames[0].activeBranchId
    const sourceScope = webEvidenceScope('project', parent.id, sourceBranch)
    const first = await f.evidence(parent, 'first', sourceScope),
      later = await f.evidence(parent, 'later', sourceScope)
    graph.activities = [
      first.activity,
      { ...later.activity, createdAt: 40, updatedAt: 45, sortIndex: 2 }
    ].map((activity) => ({
      ...activity,
      agentFrameId: graph.rootFrameId,
      messageBranchId: sourceBranch,
      promptMessageId: 'u1',
      runtimeSegmentId: graph.runtimeSegments[0].id
    }))
    parent.conversationGraph = graph
    parent.activities = graph.activities
    f.sessions.set(parent.id, parent)
    const edited = forkConversationAfterActivity(
      graph,
      'a1',
      later.activity.id,
      'before-later-tool',
      180
    )
    const candidate = {
      ...parent,
      conversationGraph: edited,
      messages: resolveActiveConversationMessages(edited),
      activities: resolveActiveConversationActivities(edited).activities
    }
    await f.lifecycle.withCanonicalPublication(candidate, parent, async () => {
      f.sessions.set(candidate.id, candidate)
      return candidate
    })
    const scope = webEvidenceScope('project', parent.id, 'before-later-tool')
    expect((await f.service.fetch(scope, continuation(first.result))).status).toBe('ok')
    expect((await f.service.fetch(scope, continuation(later.result))).error?.code).toBe(
      'INVALID_CURSOR'
    )
    expect(f.network).toHaveLength(2)
  })
  it('cleans search-only, failed-fetch and early-cancel private ledgers after canonical deletion without snapshot scopes', async () => {
    const f = await fixture()
    const ledgerRoot = join(f.root, 'private-ledger')
    const ledger = new WebInvocationStore(ledgerRoot)
    const record = (sessionId: string, operation: 'search' | 'fetch'): WebInvocationRecord => ({
      projectId: 'project',
      sessionId,
      branchId: 'branch',
      promptMessageId: 'prompt',
      agentFrameId: 'frame',
      runtimeSegmentId: 'segment',
      invocationId: `${sessionId}-invocation`,
      operation,
      input:
        operation === 'search'
          ? { query: 'Private research query' }
          : { url: 'https://example.org/private-research-query' },
      attempt: 1,
      configGeneration: 'generation',
      status: 'completed',
      createdAt: 1,
      updatedAt: 1
    })
    const search = record('search-only', 'search'),
      failed = record('failed-fetch', 'fetch')
    await ledger.create(search)
    await ledger.create(failed)
    const cancelled = {
      projectId: 'project',
      sessionId: 'early-cancel',
      invocationId: 'early-invocation',
      operation: 'search' as const,
      input: { query: 'Private cancelled query' },
      configGeneration: 'generation',
      createdAt: 1
    }
    await ledger.cancelUndispatched(cancelled)
    expect(await f.store.ownedSessions()).toEqual([])
    const restarted = new WebInvocationStore(ledgerRoot)
    const cleanup = vi.fn((binding: { projectId: string; sessionId: string }) =>
      restarted.deleteSession(binding)
    )
    const lifecycle = new WebEvidenceLifecycle(
      new WebSnapshotStore(f.root),
      async () => undefined,
      cleanup,
      () => restarted.ownedSessions()
    )
    await lifecycle.recover()
    expect(cleanup).toHaveBeenCalledWith({ projectId: 'project', sessionId: search.sessionId })
    expect(cleanup).toHaveBeenCalledWith({ projectId: 'project', sessionId: failed.sessionId })
    expect(cleanup).toHaveBeenCalledWith({ projectId: 'project', sessionId: cancelled.sessionId })
    await expect(restarted.read(search, search.invocationId)).rejects.toThrow(/deleted/)
    await expect(restarted.read(failed, failed.invocationId)).rejects.toThrow(/deleted/)
    await expect(
      restarted.readUndispatchedCancellation(cancelled, cancelled.invocationId)
    ).rejects.toThrow(/deleted/)
    expect(f.network).toHaveLength(0)
  })
  it('recovers canonical deletion before the Web tombstone and retries exact-input ledger cleanup', async () => {
    const f = await fixture(),
      parent = session('parent'),
      first = await f.evidence(parent)
    parent.activities = [first.activity]
    f.sessions.set(parent.id, parent)
    const child = childOf(parent)
    await f.lifecycle.withSessionPublication(child, async () => {
      f.sessions.set(child.id, child)
      return child
    })
    // Session authority disappeared before the process reached the Web cleanup participant.
    f.sessions.delete(parent.id)
    const cleanup = vi.fn(async () => undefined)
    const recovered = new WebEvidenceLifecycle(
      new WebSnapshotStore(f.root),
      async (_project, id) => f.sessions.get(id),
      cleanup
    )
    await recovered.recover()
    expect(cleanup).toHaveBeenCalledWith({ projectId: 'project', sessionId: parent.id })
    expect(
      (await f.service.fetch(webEvidenceScope('project', child.id), continuation(first.result)))
        .status
    ).toBe('ok')
    f.sessions.delete(child.id)
    await recovered.recover()
    await expect(
      readFile(
        join(
          f.root,
          webTextHash(webEvidenceScope('project', parent.id)),
          `${first.result.document!.snapshot_id}.json`
        )
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.network).toHaveLength(1)
  })

  it('retains references when canonical authority is unreadable and does not let unrelated malformed intents block a live save', async () => {
    const f = await fixture(),
      parent = session('parent'),
      first = await f.evidence(parent)
    parent.activities = [first.activity]
    f.sessions.set(parent.id, parent)
    const child = childOf(parent)
    await f.lifecycle.prepareFork(parent, child)
    const unreadable = new WebEvidenceLifecycle(new WebSnapshotStore(f.root), async () => {
      throw new Error('unreadable canonical JSON')
    })
    await expect(unreadable.recover()).rejects.toThrow('unreadable canonical JSON')
    expect(await f.store.pendingInheritances()).toHaveLength(1)
    await writeFile(
      join(f.root, webTextHash(webEvidenceScope('project', child.id)), 'inheritance.json'),
      'malformed'
    )
    const other = session('unrelated')
    expect(await f.lifecycle.withCanonicalPublication(other, undefined, async () => other)).toBe(
      other
    )
    expect(
      (
        await f.store.readCommitted(
          webEvidenceScope('project', parent.id),
          first.result.document!.snapshot_id
        )
      ).sha256
    ).toBe(first.result.document!.sha256)
  })

  it('retains bytes after interrupted GC and completes cleanup after restart', async () => {
    const f = await fixture(),
      parent = session('parent'),
      foreign = session('unrelated')
    const first = await f.evidence(parent),
      unrelated = await f.evidence(foreign, 'foreign')
    const marker = join(
      f.root,
      webTextHash(webEvidenceScope('project', foreign.id)),
      'committed',
      `${unrelated.result.document!.snapshot_id}.json`
    )
    const original = await readFile(marker, 'utf8')
    await writeFile(marker, 'corrupted')
    await expect(f.lifecycle.releaseSession('project', parent.id)).rejects.toThrow(
      'Web evidence cleanup is incomplete'
    )
    const body = join(
      f.root,
      webTextHash(webEvidenceScope('project', parent.id)),
      `${first.result.document!.snapshot_id}.json`
    )
    expect(await readFile(body, 'utf8')).toContain('Immutable page')
    await writeFile(marker, original)
    await new WebSnapshotStore(f.root).recoverDeletions()
    await expect(readFile(body)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      (
        await f.store.readCommitted(
          webEvidenceScope('project', foreign.id),
          unrelated.result.document!.snapshot_id
        )
      ).snapshotId
    ).toBe(unrelated.result.document!.snapshot_id)
  })
  it('notifies branch cancellation when canonical publication committed but its projection acknowledgement failed', async () => {
    const f = await fixture(),
      parent = session('parent'),
      first = await f.evidence(parent)
    parent.messages.push(message('u2', 'user', 100), message('a2', 'agent', 150))
    const graph = createLinearConversationGraph({
      sessionId: parent.id,
      messages: parent.messages,
      createdAt: 1,
      updatedAt: 150
    })
    graph.activities = [
      {
        ...first.activity,
        agentFrameId: graph.rootFrameId,
        messageBranchId: graph.frames[0].activeBranchId,
        promptMessageId: 'u1',
        runtimeSegmentId: graph.runtimeSegments[0].id
      }
    ]
    parent.conversationGraph = graph
    parent.activities = graph.activities
    f.sessions.set(parent.id, parent)
    const edited = forkEditedConversationMessage(graph, 'u2', 'edited', 180)
    const child = {
      ...parent,
      conversationGraph: edited,
      messages: resolveActiveConversationMessages(edited),
      activities: resolveActiveConversationActivities(edited).activities
    }
    const observe = vi.fn()
    const unsubscribe = subscribeWebBranchChanges(observe)
    const failure = new SessionProjectionAfterCommitError(
      child,
      new Error('projection acknowledgement failed')
    )
    try {
      await expect(
        f.lifecycle.withCanonicalPublication(child, parent, async () => {
          f.sessions.set(child.id, child)
          throw failure
        })
      ).rejects.toBe(failure)
      expect(observe).toHaveBeenCalledExactlyOnceWith({
        projectId: 'project',
        sessionId: parent.id,
        branchId: 'edited'
      })
      expect(
        (
          await f.service.fetch(
            webEvidenceScope('project', parent.id, 'edited'),
            continuation(first.result)
          )
        ).status
      ).toBe('ok')
      expect(await f.store.pendingInheritances()).toEqual([])
    } finally {
      unsubscribe()
    }
  })
  it('isolates same-session message branches and publishes branch cancellation only after durable changes', async () => {
    const f = await fixture(),
      parent = session('parent')
    parent.messages.push(message('u2', 'user', 100), message('a2', 'agent', 150))
    const graph = createLinearConversationGraph({
      sessionId: parent.id,
      messages: parent.messages,
      createdAt: 1,
      updatedAt: 150
    })
    const sourceBranch = graph.frames[0].activeBranchId
    const sourceScope = webEvidenceScope('project', parent.id, sourceBranch)
    const first = await f.evidence(parent, 'first', sourceScope),
      later = await f.evidence(parent, 'later', sourceScope)
    graph.activities = [
      first.activity,
      { ...later.activity, promptMessageId: 'u2', createdAt: 110, updatedAt: 130 }
    ].map((activity) => ({
      ...activity,
      agentFrameId: graph.rootFrameId,
      messageBranchId: sourceBranch,
      promptMessageId: activity.promptMessageId!,
      runtimeSegmentId: graph.runtimeSegments[0].id
    }))
    parent.conversationGraph = graph
    parent.activities = graph.activities
    f.sessions.set(parent.id, parent)
    const edited = forkEditedConversationMessage(graph, 'u2', 'edited', 180)
    const child: PersistedChatSession = {
      ...parent,
      conversationGraph: edited,
      messages: resolveActiveConversationMessages(edited),
      activities: resolveActiveConversationActivities(edited).activities
    }
    const changes: string[] = []
    const unsubscribe = subscribeWebBranchChanges((change) => {
      expect(f.sessions.get(parent.id)?.conversationGraph?.frames[0].activeBranchId).toBe(
        change.branchId
      )
      changes.push(change.branchId!)
    })
    try {
      await f.lifecycle.withCanonicalPublication(child, parent, async () => {
        f.sessions.set(child.id, child)
        return child
      })
      const childScope = webEvidenceScope('project', child.id, 'edited')
      expect((await f.service.fetch(childScope, continuation(first.result))).status).toBe('ok')
      expect((await f.service.fetch(childScope, continuation(later.result))).error?.code).toBe(
        'INVALID_CURSOR'
      )
      expect((await f.service.fetch(sourceScope, continuation(later.result))).status).toBe('ok')
      await f.lifecycle.withCanonicalPublication(child, child, async () => child)
      expect(changes).toEqual(['edited'])
      await f.lifecycle.releaseSession('project', child.id)
      await expect(
        f.store.readCommitted(sourceScope, later.result.document!.snapshot_id)
      ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
      await expect(
        f.store.readCommitted(childScope, first.result.document!.snapshot_id)
      ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
      expect(f.network).toHaveLength(2)
    } finally {
      unsubscribe()
    }
  })

  it.each(['missing', 'corrupt'] as const)(
    'adopts only canonical selected-branch legacy evidence and lets unrelated work proceed if its body is %s',
    async (mode) => {
      const f = await fixture(),
        parent = session('parent')
      const first = await f.evidence(parent),
        later = await f.evidence(parent, 'later')
      parent.messages.push(message('u2', 'user', 100), message('a2', 'agent', 150))
      const graph = createLinearConversationGraph({
        sessionId: parent.id,
        messages: parent.messages,
        createdAt: 1,
        updatedAt: 150
      })
      graph.activities = [
        first.activity,
        { ...later.activity, promptMessageId: 'u2', createdAt: 110, updatedAt: 130 }
      ].map((activity) => ({
        ...activity,
        agentFrameId: graph.rootFrameId,
        messageBranchId: graph.frames[0].activeBranchId,
        promptMessageId: activity.promptMessageId!,
        runtimeSegmentId: graph.runtimeSegments[0].id
      }))
      const edited = forkEditedConversationMessage(graph, 'u2', 'edited', 180)
      const canonical: PersistedChatSession = {
        ...parent,
        conversationGraph: edited,
        messages: resolveActiveConversationMessages(edited),
        activities: resolveActiveConversationActivities(edited).activities
      }
      const bodyPath = join(
        f.root,
        webTextHash(webEvidenceScope('project', parent.id)),
        `${first.result.document!.snapshot_id}.json`
      )
      if (mode === 'missing') await rm(bodyPath)
      else {
        const original = JSON.parse(await readFile(bodyPath, 'utf8'))
        await writeFile(bodyPath, JSON.stringify({ ...original, text: 'corrupted' }))
      }
      await f.lifecycle.ensureBranchOwnership(canonical, 'edited')
      const childScope = webEvidenceScope('project', parent.id, 'edited')
      expect((await f.service.fetch(childScope, continuation(first.result))).error?.code).toBe(
        'EVIDENCE_UNAVAILABLE'
      )
      expect((await f.service.fetch(childScope, continuation(later.result))).error?.code).toBe(
        'INVALID_CURSOR'
      )
      expect(
        (await f.service.fetch(childScope, { url: 'https://example.org/new-work' })).status
      ).toBe('ok')
      expect(f.network).toHaveLength(3)
    }
  )
  it('inherits only completed evidence before the branch point and keeps its exact cursor/hash', async () => {
    const f = await fixture(),
      parent = session('parent')
    const first = await f.evidence(parent)
    const later = await f.evidence(parent, 'later')
    parent.messages.push(message('u2', 'user', 100), message('a2', 'agent', 150))
    parent.activities = [
      first.activity,
      { ...later.activity, promptMessageId: 'u2', createdAt: 110, updatedAt: 130 }
    ]
    f.sessions.set(parent.id, parent)
    const child = childOf(parent)
    expect(inheritedWebSnapshotIds(parent, child)).toEqual([first.result.document!.snapshot_id])
    await f.lifecycle.withSessionPublication(child, async () => {
      f.sessions.set(child.id, child)
      return child
    })
    const childScope = webEvidenceScope(child.projectId, child.id)
    expect((await f.service.fetch(childScope, continuation(first.result))).document?.text).toBe(
      'able page evidence with a remaining fragment.'
    )
    expect((await f.service.fetch(childScope, continuation(later.result))).error?.code).toBe(
      'INVALID_CURSOR'
    )
    expect(
      (await f.store.readCommitted(childScope, first.result.document!.snapshot_id)).sha256
    ).toBe(first.result.document!.sha256)
    expect(child.activities).toEqual(parent.activities)
    expect(f.network).toHaveLength(2)
  })

  it('rejects a result that started before but completed after an old assistant/user cutoff', async () => {
    const f = await fixture(),
      parent = session('parent'),
      first = await f.evidence(parent)
    parent.activities = [{ ...first.activity, createdAt: 20, updatedAt: 70 }]
    const child = childOf(parent)
    expect(inheritedWebSnapshotIds(parent, child)).toEqual([])
    child.branchSource!.headMessageId = 'u1'
    parent.activities[0].createdAt = 5
    expect(inheritedWebSnapshotIds(parent, child)).toEqual([])
    parent.activities[0].updatedAt = 8
    expect(inheritedWebSnapshotIds(parent, child)).toEqual([first.result.document!.snapshot_id])
  })

  it('does not grant unrelated evidence merely because a body exists or a child claims the envelope', async () => {
    const f = await fixture(),
      parent = session('parent'),
      foreign = session('foreign')
    const evidence = await f.evidence(foreign)
    parent.activities = [evidence.activity]
    f.sessions.set(parent.id, parent)
    const child = childOf(parent)
    await expect(
      f.lifecycle.withSessionPublication(child, async () => child)
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    expect(
      (await f.service.fetch(webEvidenceScope('project', child.id), continuation(evidence.result)))
        .error?.code
    ).toBe('INVALID_CURSOR')
    expect(f.network).toHaveLength(1)
  })

  it('keeps child evidence after parent deletion and removes bytes only after the final reference', async () => {
    const f = await fixture(),
      parent = session('parent'),
      first = await f.evidence(parent)
    parent.activities = [first.activity]
    f.sessions.set(parent.id, parent)
    const child = childOf(parent)
    await f.lifecycle.withSessionPublication(child, async () => {
      f.sessions.set(child.id, child)
      return child
    })
    const grandchild = {
      ...childOf(child, 'grandchild'),
      branchSource: { sessionId: child.id, headMessageId: 'a1' }
    }
    await f.lifecycle.withSessionPublication(grandchild, async () => {
      f.sessions.set(grandchild.id, grandchild)
      return grandchild
    })
    const body = join(
      f.root,
      webTextHash(webEvidenceScope('project', parent.id)),
      `${first.result.document!.snapshot_id}.json`
    )
    const originalBytes = await readFile(body, 'utf8')
    await f.lifecycle.releaseSession('project', parent.id)
    await f.lifecycle.releaseSession('project', child.id)
    expect(await readFile(body, 'utf8')).toBe(originalBytes)
    const restarted = new WebService({
      store: new WebSnapshotStore(f.root),
      transport: async () => {
        throw new Error('offline')
      }
    })
    expect(
      (
        await restarted.fetch(
          webEvidenceScope('project', grandchild.id),
          continuation(first.result)
        )
      ).status
    ).toBe('ok')
    await f.lifecycle.releaseSession('project', grandchild.id)
    await expect(readFile(body)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      f.store.commit(webEvidenceScope('project', parent.id), first.result.document!.snapshot_id)
    ).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' })
    expect(f.network).toHaveLength(1)
  })

  it('retains prepared references across concurrent parent deletion without exposing uncommitted child access', async () => {
    const f = await fixture(),
      parent = session('parent'),
      first = await f.evidence(parent)
    parent.activities = [first.activity]
    f.sessions.set(parent.id, parent)
    const child = childOf(parent)
    await f.lifecycle.prepareFork(parent, child)
    await new WebSnapshotStore(f.root).releaseSession(webEvidenceScope('project', parent.id))
    expect(
      (await f.service.fetch(webEvidenceScope('project', child.id), continuation(first.result)))
        .error?.code
    ).toBe('INVALID_CURSOR')
    f.sessions.set(child.id, child)
    const recovered = new WebEvidenceLifecycle(new WebSnapshotStore(f.root), async (_project, id) =>
      f.sessions.get(id)
    )
    await recovered.recover()
    expect(
      (await f.service.fetch(webEvidenceScope('project', child.id), continuation(first.result)))
        .status
    ).toBe('ok')
    expect(await f.store.pendingInheritances()).toEqual([])
    expect(f.network).toHaveLength(1)
  })

  it('releases a failed fork intent and collects the body after parent deletion', async () => {
    const f = await fixture(),
      parent = session('parent'),
      first = await f.evidence(parent)
    parent.activities = [first.activity]
    f.sessions.set(parent.id, parent)
    const child = childOf(parent)
    await expect(
      f.lifecycle.withSessionPublication(child, async () => {
        await f.lifecycle.releaseSession('project', parent.id)
        throw new Error('child save failed')
      })
    ).rejects.toThrow('child save failed')
    expect(await f.store.pendingInheritances()).toEqual([])
    await expect(
      f.store.read(webEvidenceScope('project', parent.id), first.result.document!.snapshot_id)
    ).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' })
  })

  it('serializes reads, fork and deletion across store instances and recovers an interrupted cleanup', async () => {
    const f = await fixture(),
      parent = session('parent'),
      first = await f.evidence(parent)
    parent.activities = [first.activity]
    f.sessions.set(parent.id, parent)
    const scope = webEvidenceScope('project', parent.id)
    const read = f.store.readCommitted(scope, first.result.document!.snapshot_id)
    const deletion = new WebSnapshotStore(f.root).releaseSession(scope)
    expect((await read).text).toContain('Immutable page')
    await deletion
    await new WebSnapshotStore(f.root).recoverDeletions()
    await expect(
      f.store.readCommitted(scope, first.result.document!.snapshot_id)
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    await expect(f.lifecycle.prepareFork(parent, childOf(parent))).rejects.toMatchObject({
      code: 'EVIDENCE_UNAVAILABLE'
    })
  })

  it('keeps unavailable inherited history references without blocking an unrelated URL', async () => {
    const f = await fixture(),
      parent = session('parent'),
      first = await f.evidence(parent)
    parent.activities = [first.activity]
    f.sessions.set(parent.id, parent)
    await rm(
      join(
        f.root,
        webTextHash(webEvidenceScope('project', parent.id)),
        `${first.result.document!.snapshot_id}.json`
      )
    )
    const child = childOf(parent)
    await f.lifecycle.withSessionPublication(child, async () => {
      f.sessions.set(child.id, child)
      return child
    })
    const childScope = webEvidenceScope('project', child.id)
    expect((await f.service.fetch(childScope, continuation(first.result))).error?.code).toBe(
      'EVIDENCE_UNAVAILABLE'
    )
    expect(
      (await f.service.fetch(childScope, { url: 'https://example.org/unrelated' })).status
    ).toBe('ok')
    expect(f.network).toHaveLength(2)
    expect(child.activities?.[0].rawOutput).toEqual(first.result)
  })

  it('fails closed for corrupt child ownership/body while saved history remains unchanged', async () => {
    const f = await fixture(),
      parent = session('parent'),
      first = await f.evidence(parent)
    parent.activities = [first.activity]
    f.sessions.set(parent.id, parent)
    const child = childOf(parent)
    await f.lifecycle.withSessionPublication(child, async () => {
      f.sessions.set(child.id, child)
      return child
    })
    const body = join(
      f.root,
      webTextHash(webEvidenceScope('project', parent.id)),
      `${first.result.document!.snapshot_id}.json`
    )
    const canonical = JSON.parse(await readFile(body, 'utf8'))
    await writeFile(body, JSON.stringify({ ...canonical, text: 'corrupted' }))
    expect(
      (await f.service.fetch(webEvidenceScope('project', child.id), continuation(first.result)))
        .error?.code
    ).toBe('EVIDENCE_UNAVAILABLE')
    expect(child.activities?.[0].rawOutput).toEqual(first.result)
    expect(f.network).toHaveLength(1)
  })
})
