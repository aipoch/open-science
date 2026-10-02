import { createLinearConversationGraph } from '../../shared/conversation-graph'
import { expect, it, vi } from 'vitest'
import { SessionReadingOwner } from './session-reading'
import type { SessionReplayRepository } from './repository'
import type { SessionRuntimeContext } from '../../shared/session-runtime-context'
import type { SessionDiscussionSnapshot } from '../../shared/session-replay'
import { readLinkedSession } from '../notebook/host-session-reading'
import type { PersistedChatSession } from '../../shared/session-persistence'

const snapshot: SessionDiscussionSnapshot = {
  id: 'snapshot',
  projectId: 'source-project',
  sourceSessionId: 'source',
  sourceTitle: 'Analysis',
  branchId: 'main',
  stepId: 'activity:a',
  fingerprint: 'original',
  excerpt: 'SECRET LARGE OUTPUT',
  phase: 'input',
  evidence: [
    { kind: 'activity', id: 'a', projectId: 'source-project', sessionId: 'source', part: 'input' }
  ]
}
const base = (id: string): PersistedChatSession => ({
  id,
  projectId: 'project',
  title: id,
  cwd: '',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1
})

it('rejects self-discussion before changing the receiving Session', async () => {
  const sessions = {
    readSessionRuntimeContext: vi.fn(async (): Promise<SessionRuntimeContext> => ({
      version: 1,
      revision: 0
    })),
    patchSessionRuntimeContext: vi.fn()
  }
  const owner = new SessionReadingOwner(
    {
      getSelectionSnapshot: vi.fn(async () => snapshot)
    } as unknown as SessionReplayRepository,
    sessions
  )
  await expect(
    owner.prepare({
      projectId: snapshot.projectId,
      sessionId: snapshot.sourceSessionId,
      promptMessageId: 'question',
      sources: [{ projectId: snapshot.projectId, id: snapshot.id }]
    })
  ).rejects.toThrow('cannot discuss itself')
  expect(sessions.patchSessionRuntimeContext).not.toHaveBeenCalled()
})

it('persists a compact source association, restores it on later turns, updates focus, and respects unlink', async () => {
  let context: SessionRuntimeContext = { version: 1, revision: 0 }
  const repository = {
    getSelectionSnapshot: vi.fn(async () => snapshot)
  } as unknown as SessionReplayRepository
  const sessions = {
    readSessionRuntimeContext: vi.fn(async () => context),
    patchSessionRuntimeContext: vi.fn(async (request) => {
      expect(request.expectedRevision).toBe(context.revision)
      context = { ...context, ...request.patch, revision: context.revision + 1 }
      return context
    })
  }
  const owner = new SessionReadingOwner(repository, sessions)
  const request = {
    projectId: 'project',
    sessionId: 'receiving',
    promptMessageId: 'question',
    sources: [{ projectId: 'source-project', id: 'snapshot' }]
  }
  const prompt = await owner.prepare(request)
  expect(prompt).toContain('host.sessions.read()')
  expect(prompt).not.toContain('SECRET LARGE OUTPUT')
  expect(prompt).not.toContain('contextId')
  expect(prompt).not.toContain('fingerprint')
  expect(context.sessionContext?.bindings[0].sessionId).toBe('source')
  expect(
    await new SessionReadingOwner(repository, sessions).prepare({ ...request, sources: [] })
  ).toBe(prompt)
  expect(sessions.patchSessionRuntimeContext).toHaveBeenCalledTimes(1)
  await owner.unlink({
    projectId: 'project',
    sessionId: 'receiving',
    sourceSessionId: 'source',
    expectedRevision: 1
  })
  expect(await owner.prepare({ ...request, sources: [] })).toBeUndefined()
  expect(await owner.prepare(request)).toBeUndefined()
})

it('reads full tool content on demand, defaults to selected input, pages results, and revokes on unlink', async () => {
  const receiving = {
    ...base('receiving'),
    runtimeContext: {
      version: 1 as const,
      revision: 1,
      sessionContext: {
        version: 1 as const,
        bindings: [
          {
            projectId: 'source-project',
            sessionId: 'source',
            contextId: 'snapshot',
            title: 'Analysis',
            branchId: 'main',
            promptMessageId: 'question'
          }
        ]
      }
    }
  }
  const source = {
    ...base('source'),
    activities: [
      {
        id: 'a',
        kind: 'tool' as const,
        title: 'Compute',
        status: 'completed' as const,
        sortIndex: 0,
        eventIds: [],
        createdAt: 1,
        updatedAt: 2,
        rawInput: { code: 'print(42)' },
        rawOutput: 'result:42'
      }
    ]
  }
  const deps = {
    contexts: {
      getSelectionSnapshot: async () => snapshot
    } as unknown as SessionReplayRepository,
    readSession: async (_project: string, id: string) => (id === 'receiving' ? receiving : source),
    readRuns: vi.fn(async () => [])
  }
  const caller = { projectId: 'project', sessionId: 'receiving' }
  const input = await readLinkedSession(deps, caller, 'source', { kind: 'activity', id: 'a' })
  expect(JSON.stringify(input)).toContain('print(42)')
  expect(JSON.stringify(input)).not.toContain('result:42')
  const result = (await readLinkedSession(deps, caller, 'source', {
    kind: 'activity',
    id: 'a',
    part: 'result',
    limit: 12
  })) as { text: string; nextOffset: number }
  expect(result.text.length).toBe(12)
  expect(result.nextOffset).toBe(12)
  const remainder = await readLinkedSession(deps, caller, 'source', {
    kind: 'activity',
    id: 'a',
    part: 'result',
    offset: 12
  })
  expect(JSON.stringify(remainder)).toContain('result:42')
  expect(deps.readRuns).not.toHaveBeenCalled()
  await expect(readLinkedSession(deps, caller, 'unlinked', {})).rejects.toThrow('not linked')
  await expect(readLinkedSession(deps, caller, 'source', { projectId: 'other' })).rejects.toThrow()
  receiving.runtimeContext.sessionContext.bindings = []
  await expect(readLinkedSession(deps, caller, 'source', {})).rejects.toThrow('not linked')
})

it('reads only the linked immutable file version and omits reviewer internal logs', async () => {
  const fileSnapshot: SessionDiscussionSnapshot = {
    ...snapshot,
    phase: 'result',
    evidence: [
      {
        kind: 'artifact-version',
        id: 'file',
        versionId: 'v1',
        projectId: 'source-project',
        sessionId: 'source'
      },
      { kind: 'review', id: 'review', projectId: 'source-project', sessionId: 'source' }
    ]
  }
  const file = {
    source: 'artifact' as const,
    sourceFileId: 'file',
    versionId: 'v1',
    projectId: 'source-project',
    sessionId: 'source',
    filename: 'results.csv',
    sizeBytes: 10,
    sortAtMs: 1,
    createdAt: '2026-09-30',
    rootFrameId: null,
    agentFrameId: null
  }
  const receiving: PersistedChatSession = {
    ...base('receiving'),
    runtimeContext: {
      version: 1,
      revision: 1,
      sessionContext: {
        version: 1,
        bindings: [
          {
            projectId: 'source-project',
            sessionId: 'source',
            contextId: 'snapshot',
            title: 'Analysis',
            branchId: 'main',
            promptMessageId: 'question'
          }
        ]
      }
    }
  }
  const review = {
    id: 'review',
    projectId: 'source-project',
    sessionId: 'source',
    lifecycle: 'completed',
    outcome: 'pass',
    checks: [],
    reviewerLog: 'PRIVATE LOG'
  } as unknown as import('../../shared/reviewer').ReviewWithChecks
  const deps = {
    contexts: {
      getSelectionSnapshot: async () => fileSnapshot
    } as unknown as SessionReplayRepository,
    readSession: async (_project: string, id: string) =>
      id === 'receiving' ? receiving : base('source'),
    readRuns: async () => [],
    readFiles: async () => [
      file,
      { ...file, versionId: 'v2' },
      { ...file, versionId: 'foreign', sessionId: 'other' }
    ],
    readFile: vi.fn(async () => 'a,b\n1,2'),
    readReviews: async () => [review]
  }
  const caller = { projectId: 'project', sessionId: 'receiving' }
  expect(
    await readLinkedSession(deps, caller, 'source', { kind: 'artifact-version', id: 'v1' })
  ).toMatchObject({ text: 'a,b\n1,2' })
  expect(deps.readFile).toHaveBeenCalledExactlyOnceWith(file)
  await expect(
    readLinkedSession(deps, caller, 'source', { kind: 'artifact-version', id: 'v2' })
  ).rejects.toThrow('unavailable')
  await expect(
    readLinkedSession(deps, caller, 'source', { kind: 'artifact-version', id: 'foreign' })
  ).rejects.toThrow('unavailable')
  const result = JSON.stringify(
    await readLinkedSession(deps, caller, 'source', { kind: 'review', id: 'review' })
  )
  expect(result).toContain('pass')
  expect(result).not.toContain('PRIVATE LOG')
  file.filename = 'plot.png'
  deps.readFile.mockResolvedValue('Image metadata, not pixels')
  expect(await readLinkedSession(deps, caller, undefined, { id: 'v1' })).not.toHaveProperty(
    'viewImage'
  )
  receiving.projectId = file.projectId
  expect(
    await readLinkedSession(deps, { ...caller, projectId: file.projectId }, undefined, { id: 'v1' })
  ).toMatchObject({
    viewImage: { versionId: 'v1' }
  })
})

it('keeps all steps from one question, reads each linked Branch, and updates positions on the next question', async () => {
  const snapshots: SessionDiscussionSnapshot[] = ['first', 'second', 'third'].map((id, index) => ({
    ...snapshot,
    id,
    branchId: index === 2 ? 'alternative' : 'main',
    stepTitle: `Selected ${id}`,
    stepNumber: index + 1,
    branchIndex: index === 2 ? 1 : 0,
    stepId: `step-${id}`,
    evidence: [
      { kind: 'notebook-run', id, projectId: 'source-project', sessionId: 'source', part: 'input' }
    ]
  }))
  let context: SessionRuntimeContext = { version: 1, revision: 0 }
  const contexts = {
    getSelectionSnapshot: vi.fn(async ({ id }: { id: string }) =>
      snapshots.find((snapshot) => snapshot.id === id)
    )
  } as unknown as SessionReplayRepository
  const owner = new SessionReadingOwner(contexts, {
    readSessionRuntimeContext: async () => context,
    patchSessionRuntimeContext: async ({ patch }) =>
      (context = { ...context, ...patch, revision: context.revision + 1 })
  })
  const request = {
    projectId: 'project',
    sessionId: 'receiving',
    promptMessageId: 'compare',
    sources: snapshots.map(({ id }) => ({ id, projectId: 'source-project' }))
  }
  const prompt = await owner.prepare(request)
  expect(context.sessionContext?.bindings).toHaveLength(1)
  expect(
    context.sessionContext?.bindings[0].positions?.map((position) => position.contextId)
  ).toEqual(['first', 'second', 'third'])
  expect(JSON.parse(prompt!.split('\n')[1])[0].selectedSteps).toEqual([
    { branchNumber: 1, stepNumber: 1, title: 'Selected first' },
    { branchNumber: 1, stepNumber: 2, title: 'Selected second' },
    { branchNumber: 2, stepNumber: 3, title: 'Selected third' }
  ])
  expect(prompt).not.toContain('"id":')
  const deps = {
    contexts,
    readSession: async (_project: string, id: string) =>
      id === 'receiving' ? { ...base(id), runtimeContext: context } : base(id),
    readRuns: async () =>
      snapshots.map(
        (snapshot) =>
          ({
            runId: snapshot.id,
            messageBranchId: snapshot.branchId,
            script: `code ${snapshot.id}`,
            text: { stdout: 'hidden' },
            status: 'completed'
          }) as import('../../shared/notebook').NotebookRunRecord
      )
  }
  const caller = { projectId: 'project', sessionId: 'receiving' }
  const index = (await readLinkedSession(deps, caller, undefined, {})) as {
    records: Array<{ id: string; read: Record<string, unknown> }>
  }
  expect(index.records.map((record) => record.id)).toEqual(['first', 'second', 'third'])
  for (const record of index.records) {
    expect(await readLinkedSession(deps, caller, undefined, record.read)).toMatchObject({
      text: `code ${record.id}`,
      part: 'input'
    })
  }
  expect(await readLinkedSession(deps, caller, undefined, { id: 'first' })).toMatchObject({
    branchId: 'main',
    text: 'code first'
  })
  expect(await readLinkedSession(deps, caller, undefined, { id: 'third' })).toMatchObject({
    branchId: 'alternative',
    text: 'code third'
  })
  const first = await readLinkedSession(deps, caller, 'source', {
    branchId: 'main',
    kind: 'notebook-run',
    id: 'first'
  })
  expect(first).toMatchObject({ text: 'code first', part: 'input' })
  await expect(
    readLinkedSession(deps, caller, 'source', {
      branchId: 'alternative',
      kind: 'notebook-run',
      id: 'first'
    })
  ).rejects.toThrow('unavailable')
  await expect(readLinkedSession(deps, caller, 'source', { branchId: 'unlinked' })).rejects.toThrow(
    'not linked'
  )
  expect(
    await readLinkedSession(deps, caller, 'source', {
      branchId: 'alternative',
      kind: 'notebook-run',
      id: 'third'
    })
  ).toMatchObject({ text: 'code third' })
  const updatedPrompt = await owner.prepare({
    ...request,
    promptMessageId: 'follow-up',
    sources: [request.sources[1]]
  })
  expect(JSON.parse(updatedPrompt!.split('\n')[1])[0].selectedSteps).toEqual([
    { branchNumber: 1, stepNumber: 2, title: 'Selected second' }
  ])
  expect(updatedPrompt).toContain('Call host.sessions.read() again on this turn')
  expect(await owner.prepare({ ...request, promptMessageId: 'later', sources: [] })).toBe(
    updatedPrompt
  )
  expect(await readLinkedSession(deps, caller, undefined, {})).toMatchObject({
    records: [{ id: 'second', stepNumber: 2 }]
  })
  expect(
    context.sessionContext?.bindings[0].positions?.map((position) => position.contextId)
  ).toEqual(['second'])
})

it('replaces the linked Session rather than retaining hidden sources in Agent context', async () => {
  let context: SessionRuntimeContext = { version: 1, revision: 0 }
  const replacement = {
    ...snapshot,
    id: 'replacement',
    sourceSessionId: 'other',
    sourceTitle: 'Other'
  }
  const repository = {
    getSelectionSnapshot: vi.fn(async ({ id }) => (id === 'replacement' ? replacement : snapshot))
  } as unknown as SessionReplayRepository
  const sessions = {
    readSessionRuntimeContext: async () => context,
    patchSessionRuntimeContext: vi.fn(async (request) => {
      context = { ...context, ...request.patch, revision: context.revision + 1 }
      return context
    })
  }
  const owner = new SessionReadingOwner(repository, sessions)
  const request = {
    projectId: 'project',
    sessionId: 'receiving',
    promptMessageId: 'one',
    sources: [{ projectId: 'source-project', id: 'snapshot' }]
  }
  await owner.prepare(request)
  const prompt = await owner.prepare({
    ...request,
    promptMessageId: 'two',
    sources: [{ projectId: 'source-project', id: 'replacement' }]
  })
  expect(context.sessionContext?.bindings).toHaveLength(1)
  expect(context.sessionContext?.bindings[0].sessionId).toBe('other')
  expect(prompt).not.toContain('"sessionId":"source"')
  await expect(
    readLinkedSession(
      {
        contexts: repository,
        readSession: async () => ({ ...base('receiving'), runtimeContext: context }),
        readRuns: async () => []
      },
      { projectId: 'project', sessionId: 'receiving' },
      'source',
      {}
    )
  ).rejects.toThrow('not linked')
  await owner.unlink({
    projectId: 'project',
    sessionId: 'receiving',
    sourceSessionId: 'other',
    expectedRevision: context.revision
  })
  expect(await owner.prepare({ ...request, promptMessageId: 'three', sources: [] })).toBeUndefined()
})

it('reads only saved selected fragments after source deletion, without inventing uncaptured output', async () => {
  const receiving = base('receiving')
  receiving.runtimeContext = {
    version: 1,
    revision: 1,
    sessionContext: {
      version: 1,
      bindings: [
        {
          projectId: 'source-project',
          sessionId: 'source',
          contextId: 'snapshot',
          title: 'Analysis',
          branchId: 'main',
          promptMessageId: 'q'
        }
      ]
    }
  }
  const saved = {
    ...snapshot,
    records: [
      {
        id: 'activity:a',
        scope: 'step' as const,
        title: 'Input',
        text: 'print(42)',
        status: 'recorded' as const,
        truncated: false
      }
    ]
  }
  const deps = {
    contexts: { getSelectionSnapshot: async () => saved } as unknown as SessionReplayRepository,
    readSession: async (_project: string, id: string) =>
      id === 'receiving' ? receiving : undefined,
    readRuns: vi.fn(async () => [])
  }
  const caller = { projectId: 'project', sessionId: 'receiving' }
  expect(await readLinkedSession(deps, caller, 'source', {})).toMatchObject({
    availability: 'saved-fragments-only',
    records: [{ kind: 'activity', id: 'a' }]
  })
  expect(
    await readLinkedSession(deps, caller, 'source', { kind: 'activity', id: 'a', limit: 5 })
  ).toMatchObject({
    text: 'print',
    incomplete: true,
    nextOffset: 5,
    availability: 'saved-fragments-only'
  })
  await expect(
    readLinkedSession(deps, caller, 'source', { kind: 'activity', id: 'a', part: 'result' })
  ).rejects.toThrow('unavailable')
  await expect(
    readLinkedSession(deps, caller, 'source', { kind: 'message', id: 'other' })
  ).rejects.toThrow('unavailable')
  expect(deps.readRuns).not.toHaveBeenCalled()
  receiving.runtimeContext.sessionContext!.bindings = []
  await expect(readLinkedSession(deps, caller, 'source', {})).rejects.toThrow('not linked')
})

it('uses indexed run lookup for repeated Agent content pages', async () => {
  const receiving = base('receiving')
  receiving.runtimeContext = {
    version: 1,
    revision: 1,
    sessionContext: {
      version: 1,
      bindings: [
        {
          projectId: 'source-project',
          sessionId: 'source',
          contextId: 'snapshot',
          title: 'Analysis',
          branchId: 'main',
          promptMessageId: 'q'
        }
      ]
    }
  }
  const deps = {
    contexts: {
      getSelectionSnapshot: async () => ({
        ...snapshot,
        evidence: [
          {
            kind: 'notebook-run',
            id: 'run',
            projectId: 'source-project',
            sessionId: 'source',
            part: 'input'
          }
        ]
      })
    } as unknown as SessionReplayRepository,
    readSession: async (_project: string, id: string) =>
      id === 'receiving' ? receiving : base('source'),
    readRun: vi.fn(
      async () =>
        ({
          runId: 'run',
          messageBranchId: 'ancestor-branch',
          script: 'x'.repeat(20000),
          text: {},
          status: 'completed'
        }) as unknown as import('../../shared/notebook').NotebookRunRecord
    ),
    readRuns: vi.fn(async () => [])
  }
  for (const offset of [0, 8000, 16000]) {
    expect(
      await readLinkedSession(deps, { projectId: 'project', sessionId: 'receiving' }, 'source', {
        kind: 'notebook-run',
        id: 'run',
        offset
      })
    ).toMatchObject({ text: 'x'.repeat(Math.min(8000, 20000 - offset)) })
  }
  expect(deps.readRun).toHaveBeenCalledTimes(3)
  expect(deps.readRuns).not.toHaveBeenCalled()
})

it('returns copyable pagination and requires disambiguation only when selected record identities collide', async () => {
  const selections = ['main', 'alternative'].map((branchId) => ({
    ...snapshot,
    id: branchId,
    branchId,
    records: [
      {
        id: 'activity:a',
        scope: 'step' as const,
        title: branchId,
        text: `saved ${branchId}`,
        status: 'recorded' as const,
        truncated: false
      }
    ]
  }))
  const receiving = {
    ...base('receiving'),
    runtimeContext: {
      version: 1 as const,
      revision: 1,
      sessionContext: {
        version: 1 as const,
        bindings: [
          {
            projectId: 'source-project',
            sessionId: 'source',
            contextId: 'main',
            title: 'Analysis',
            branchId: 'main',
            promptMessageId: 'q',
            positions: selections.map(({ id, branchId }) => ({ contextId: id, branchId }))
          }
        ]
      }
    }
  }
  const deps = {
    contexts: {
      getSelectionSnapshot: async ({ id }: { id: string }) =>
        selections.find((row) => row.id === id)
    } as unknown as SessionReplayRepository,
    readSession: async (_project: string, id: string) =>
      id === 'receiving' ? receiving : undefined,
    readRuns: vi.fn(async () => [])
  }
  const caller = { projectId: 'project', sessionId: 'receiving' }
  await expect(readLinkedSession(deps, caller, undefined, { id: 'a' })).rejects.toThrow('branchId')
  const first = (await readLinkedSession(deps, caller, undefined, { limit: 1 })) as {
    records: Array<{ read: Record<string, unknown> }>
    next: Record<string, unknown>
  }
  const second = (await readLinkedSession(deps, caller, undefined, first.next)) as typeof first
  expect(second.records[0].read).toMatchObject({
    branchId: 'alternative',
    kind: 'activity',
    id: 'a',
    part: 'input'
  })
  const page = (await readLinkedSession(deps, caller, undefined, {
    ...second.records[0].read,
    limit: 6
  })) as {
    text: string
    next: Record<string, unknown>
  }
  const remainder = (await readLinkedSession(deps, caller, undefined, page.next)) as {
    text: string
    next: Record<string, unknown>
  }
  const last = (await readLinkedSession(deps, caller, undefined, remainder.next)) as {
    text: string
    next?: unknown
  }
  expect(page.text + remainder.text + last.text).toBe('saved alternative')
  expect(last.next).toBeUndefined()
  await expect(
    readLinkedSession(deps, caller, undefined, { ...second.records[0].read, part: 'result' })
  ).rejects.toThrow('unavailable')
  expect(deps.readRuns).not.toHaveBeenCalled()
  const resultSelection = {
    ...selections[0],
    id: 'result',
    phase: 'result' as const,
    evidence: [{ ...snapshot.evidence[0], part: 'result' as const }],
    records: [{ ...selections[0].records[0], text: 'saved result' }]
  }
  selections.push(resultSelection)
  receiving.runtimeContext.sessionContext.bindings[0].positions.push({
    contextId: 'result',
    branchId: 'main'
  })
  await expect(
    readLinkedSession(deps, caller, undefined, { id: 'a', branchId: 'main' })
  ).rejects.toThrow('multiple selected parts')
  const selectedParts = (await readLinkedSession(deps, caller, undefined, {
    branchId: 'main'
  })) as {
    records: Array<{ read: Record<string, unknown> }>
  }
  expect(
    await readLinkedSession(deps, caller, undefined, selectedParts.records[0].read)
  ).toMatchObject({ text: 'saved main', part: 'input' })
  expect(
    await readLinkedSession(deps, caller, undefined, selectedParts.records[1].read)
  ).toMatchObject({ text: 'saved result', part: 'result' })
})

it('supports learning from an entire imported Session and resolves nearby messages without inventing context', async () => {
  const messages: PersistedChatSession['messages'] = Array.from({ length: 12 }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 ? 'agent' : 'user',
    status: 'complete',
    content: index === 6 ? 'Explain this parameter. ' + 'x'.repeat(1400) : `Message ${index}`,
    eventIds: [],
    createdAt: index,
    updatedAt: index
  }))
  const graph = createLinearConversationGraph({
    sessionId: 'source',
    messages,
    createdAt: 1,
    updatedAt: 1
  })
  const main = graph.branches[0]
  graph.branches.push({ ...main, id: 'other' })
  let selection: SessionDiscussionSnapshot = {
    ...snapshot,
    scope: 'session',
    branchId: main.id,
    stepNumber: 7,
    stepTitle: 'Parameter choice',
    evidence: [{ kind: 'message', id: 'm6', projectId: 'source-project', sessionId: 'source' }]
  }
  let runtime: SessionRuntimeContext = { version: 1, revision: 0 }
  let source: PersistedChatSession | undefined = {
    ...base('source'),
    messages,
    conversationGraph: graph
  }
  const contexts = {
    getSelectionSnapshot: vi.fn(async () => selection)
  } as unknown as SessionReplayRepository
  const owner = new SessionReadingOwner(contexts, {
    readSessionRuntimeContext: async () => runtime,
    patchSessionRuntimeContext: async ({ patch }) =>
      (runtime = { ...runtime, ...patch, revision: runtime.revision + 1 })
  })
  const prompt = await owner.prepare({
    projectId: 'project',
    sessionId: 'receiving',
    promptMessageId: 'q',
    sources: [{ projectId: 'source-project', id: 'snapshot' }]
  })
  expect(prompt).toContain('"scope":"session"')
  expect(prompt).toContain('JavaScript REPL')
  expect(prompt).toContain('beginner')
  const deps = {
    contexts,
    readSession: async (_project: string, id: string) =>
      id === 'receiving' ? { ...base(id), runtimeContext: runtime } : source,
    readRuns: async () => []
  }
  const caller = { projectId: 'project', sessionId: 'receiving' }
  const overview = (await readLinkedSession(deps, caller, undefined, {})) as {
    records: Array<{ id: string; read: Record<string, unknown> }>
    branches: Array<{ read: Record<string, unknown> }>
  }
  expect(overview).toMatchObject({
    scope: 'session',
    messageCount: 12,
    branchCount: 2,
    coverage: expect.stringContaining('not a full-history summary')
  })
  expect(overview.records.map((record) => record.id)).toEqual([
    'm0',
    'm1',
    'm2',
    'm9',
    'm10',
    'm11'
  ])
  expect(await readLinkedSession(deps, caller, undefined, overview.branches[1].read)).toMatchObject(
    { branchId: 'other' }
  )
  const nearby = (await readLinkedSession(deps, caller, undefined, { kind: 'context' })) as {
    records: Array<{ id: string; read: Record<string, unknown> }>
  }
  expect(nearby.records.map((record) => record.id)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8'])
  expect(await readLinkedSession(deps, caller, undefined, nearby.records[2].read)).toMatchObject({
    text: messages[6].content,
    source: { messageNumber: 7, stepNumber: 7, stepTitle: 'Parameter choice' }
  })
  selection = { ...selection, scope: 'step' }
  const focused = (await readLinkedSession(deps, caller, undefined, {})) as {
    overview: unknown
    nearby: unknown
    records: Array<{ read: Record<string, unknown> }>
  }
  expect(focused).toMatchObject({
    overview: { kind: 'overview' },
    nearby: { kind: 'context' },
    records: [{ stepNumber: 7 }]
  })
  // Display labels must never leak into the strict callable options.
  expect(await readLinkedSession(deps, caller, undefined, focused.records[0].read)).toMatchObject({
    text: messages[6].content
  })
  await expect(
    readLinkedSession(deps, caller, undefined, { kind: 'overview', branchId: 'other' })
  ).rejects.toThrow('not linked')
  source = undefined
  expect(await readLinkedSession(deps, caller, undefined, { kind: 'context' })).toMatchObject({
    availability: 'saved-fragments-only',
    records: [],
    notice: expect.stringContaining('Only saved selected fragments')
  })
})

it('deduplicates submitted selections by branch and step and replaces whole-study scope', async () => {
  const snapshots: SessionDiscussionSnapshot[] = [
    { ...snapshot, id: 'first', stepId: 'one' },
    { ...snapshot, id: 'repeated', stepId: 'one', stepOffsetMs: 500 },
    { ...snapshot, id: 'second', stepId: 'two' },
    { ...snapshot, id: 'whole', scope: 'session' },
    { ...snapshot, id: 'whole-again', scope: 'session' }
  ]
  let context: SessionRuntimeContext = { version: 1, revision: 0 }
  const owner = new SessionReadingOwner(
    {
      getSelectionSnapshot: async ({ id }: { id: string }) => snapshots.find((row) => row.id === id)
    } as unknown as SessionReplayRepository,
    {
      readSessionRuntimeContext: async () => context,
      patchSessionRuntimeContext: async ({ patch }) =>
        (context = { ...context, ...patch, revision: context.revision + 1 })
    }
  )
  const prepare = (ids: string[], promptMessageId: string): Promise<string | undefined> =>
    owner.prepare({
      projectId: 'project',
      sessionId: 'receiving',
      promptMessageId,
      sources: ids.map((id) => ({ projectId: 'source-project', id }))
    })
  await prepare(['first', 'repeated', 'second'], 'q1')
  expect(
    context.sessionContext!.bindings[0].positions!.map((position) => position.contextId)
  ).toEqual(['repeated', 'second'])
  const wholePrompt = await prepare(['first', 'whole', 'whole-again'], 'q2')
  expect(JSON.parse(wholePrompt!.split('\n')[1])[0]).toEqual({
    title: 'Analysis',
    scope: 'session'
  })
  expect(wholePrompt).toContain('Whole-session scope has no selected step')
  expect(context.sessionContext!.bindings[0]).toMatchObject({
    scope: 'session',
    positions: [{ contextId: 'whole-again' }]
  })
  expect(context.sessionContext!.bindings[0].positions).toHaveLength(1)
  await prepare(['whole', 'second'], 'q3')
  expect(context.sessionContext!.bindings[0].scope).toBeUndefined()
  expect(
    context.sessionContext!.bindings[0].positions!.map((position) => position.contextId)
  ).toEqual(['second'])
})
