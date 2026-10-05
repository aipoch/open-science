import type { ReviewWithChecks } from '../../../../shared/reviewer'
import { describe, expect, it, vi } from 'vitest'
import { createLinearConversationGraph } from '../../../../shared/conversation-graph'
import type {
  NotebookRunRecord,
  NotebookSessionReference,
  NotebookSessionState
} from '../../../../shared/notebook'
import type { ArtifactVersionDescriptor } from '../../../../shared/artifact-provenance'
import type {
  PersistedChatMessage,
  PersistedChatSession,
  PersistedToolActivity
} from '../../../../shared/session-persistence'
import type { ReplayClock, ReplayDocument, ReplayResource } from '../../../../shared/replay'
import { buildReplayDocument } from './timeline'
import { loadReplayDocument, loadReplaySource, type ReplayReaderApi } from './source'
import {
  advanceReplayClock,
  projectReplayScene,
  replayPositionAtScene,
  resolveReplayPosition,
  seekReplayClock
} from './scene'

const message = (
  id: string,
  role: 'user' | 'agent',
  createdAt: number,
  extra: Partial<PersistedChatMessage> = {}
): PersistedChatMessage => ({
  id,
  role,
  content: id,
  status: 'complete',
  createdAt,
  updatedAt: createdAt,
  eventIds: [],
  ...extra
})

const activity = (
  id: string,
  createdAt: number,
  extra: Partial<PersistedToolActivity> = {}
): PersistedToolActivity => ({
  id,
  kind: 'tool',
  title: id,
  status: 'completed',
  createdAt,
  updatedAt: createdAt + 1,
  sortIndex: createdAt,
  eventIds: [],
  ...extra
})

const session = (extra: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: 'source',
  projectId: 'project',
  title: 'Research',
  cwd: '/workspace',
  status: 'idle',
  messages: [message('q', 'user', 1), message('a', 'agent', 5, { responseToMessageId: 'q' })],
  createdAt: 1,
  updatedAt: 8,
  ...extra
})

const run = (id: string, extra: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: id,
  cellId: id,
  source: 'agent',
  kernelKind: 'python',
  script: 'print(1)',
  status: 'completed',
  startedAt: 2,
  endedAt: 3,
  text: { stdout: '1', stderr: '', traceback: '', plain: ['1'] },
  outputs: [],
  workingFiles: [],
  ...extra
})

const resource = (id: string, extra: Partial<ReplayResource> = {}): ReplayResource => ({
  id: `artifact-version:${id}`,
  name: 'plot.svg',
  projectId: 'project',
  sessionId: 'source',
  artifactId: 'plot',
  versionId: id,
  availability: 'recorded',
  ...extra
})

const state = (
  runs: NotebookRunRecord[],
  extra: Partial<NotebookSessionState> = {}
): NotebookSessionState => ({
  id: 'notebook',
  sessionId: 'source',
  cwd: '/workspace',
  notebookSessionRoot: '/notebook',
  dataRoot: '/data',
  runtimeRoot: '/runtime',
  kernelStatus: 'idle',
  runJsonPath: '/notebook/run.json',
  cells: [],
  runCount: runs.length,
  latestRunEnvironments: {},
  runs,
  recentRuns: runs,
  environments: [],
  ...extra
})

const version = (id: string, number: number): ArtifactVersionDescriptor => ({
  id,
  projectId: 'project',
  sessionId: 'source',
  artifactId: 'plot',
  versionId: id,
  versionNumber: number,
  name: 'plot.svg',
  size: 10,
  mtimeMs: number,
  checksum: id,
  createdAt: `2026-09-29T00:00:0${number}Z`,
  state: 'finalized',
  messageId: 'a'
})

const apiFor = (source = session()): ReplayReaderApi => ({
  sessions: { loadOne: vi.fn().mockResolvedValue(source) },
  notebook: {
    getReference: vi.fn().mockResolvedValue(null),
    state: vi.fn().mockResolvedValue(state([]))
  },
  artifacts: { getLineage: vi.fn().mockResolvedValue(undefined) }
})

describe('Replay read-only source loading', () => {
  it('loads full session authority, every Notebook page and every exact Artifact version', async () => {
    const source = session({
      artifacts: [
        { id: 'v2', artifactId: 'plot', versionId: 'v2', kind: 'managed-file', path: '/v2' }
      ]
    })
    const api = apiFor(source)
    vi.mocked(api.notebook.getReference).mockResolvedValue({
      projectId: 'project',
      sessionId: 'source',
      workspaceCwd: '/workspace',
      notebookSessionRoot: '/notebook',
      dataRoot: '/data',
      runtimeRoot: '/runtime',
      runJsonPath: '/notebook/run.json'
    })
    vi.mocked(api.notebook.state)
      .mockResolvedValueOnce(
        state([run('new', { startedAt: 20 })], {
          runCount: 2,
          historyPage: { hasEarlierRuns: true, oldestCursor: { startedAt: 20, runId: 'new' } }
        })
      )
      .mockResolvedValueOnce(
        state([run('old', { startedAt: 2 })], {
          runCount: 2,
          historyPage: { hasEarlierRuns: false }
        })
      )
    vi.mocked(api.artifacts.getLineage)
      .mockResolvedValueOnce({
        artifactId: 'plot',
        filename: 'plot.svg',
        originSession: { sessionId: 'source', state: 'active' },
        versions: [version('v2', 2)],
        nextCursor: 'older'
      })
      .mockResolvedValueOnce({
        artifactId: 'plot',
        filename: 'plot.svg',
        originSession: { sessionId: 'source', state: 'active' },
        versions: [version('v1', 1)]
      })
    const loaded = await loadReplaySource(api, { projectId: 'project', sessionId: 'source' })
    expect(loaded.runs.map((item) => item.runId)).toEqual(['old', 'new'])
    expect(loaded.resources.map((item) => item.versionId)).toEqual(['v2', 'v1'])
    expect(loaded.resources.find((item) => item.versionId === 'v1')?.locator).toContain('/plot/v1')
    expect(api.notebook.state).toHaveBeenLastCalledWith({
      projectId: 'project',
      sessionId: 'source',
      workspaceCwd: '/workspace',
      historyBefore: { startedAt: 20, runId: 'new' }
    })
    expect(api.artifacts.getLineage).toHaveBeenLastCalledWith({
      projectId: 'project',
      appSessionId: 'source',
      artifactId: 'plot',
      cursor: 'older'
    })
    expect(loaded.issues).toEqual([])
  })

  it('never opens Notebook state for a source without persisted Notebook history', async () => {
    const api = apiFor()
    const doc = await loadReplayDocument(api, { projectId: 'project', sessionId: 'source' })
    expect(doc.branches[0].steps).toHaveLength(2)
    expect(api.notebook.state).not.toHaveBeenCalled()
  })

  it('rejects late results after abort instead of publishing another source into the panel', async () => {
    const api = apiFor()
    const controller = new AbortController()
    vi.mocked(api.sessions.loadOne).mockImplementation(async () => {
      controller.abort()
      return session()
    })
    await expect(
      loadReplayDocument(
        api,
        { projectId: 'project', sessionId: 'source' },
        {
          signal: controller.signal
        }
      )
    ).rejects.toThrow()
    expect(api.notebook.getReference).not.toHaveBeenCalled()
  })

  it('reports broken pagination and preserves already loaded evidence', async () => {
    const api = apiFor()
    vi.mocked(api.notebook.getReference).mockResolvedValue({} as NotebookSessionReference)
    vi.mocked(api.notebook.state).mockResolvedValue(
      state([run('r')], {
        runCount: 5,
        historyPage: { hasEarlierRuns: true, oldestCursor: { startedAt: 2, runId: 'r' } }
      })
    )
    const loaded = await loadReplaySource(api, { projectId: 'project', sessionId: 'source' })
    expect(api.notebook.state).toHaveBeenCalledTimes(2)
    expect(loaded.runs).toHaveLength(1)
    expect(loaded.issues).toContainEqual({ code: 'incomplete-history' })
  })

  it('keeps an omitted exact version unavailable instead of substituting the newest version', async () => {
    const api = apiFor(
      session({
        artifacts: [
          { id: 'v1', artifactId: 'plot', versionId: 'v1', kind: 'managed-file', path: '/v1' }
        ]
      })
    )
    vi.mocked(api.artifacts.getLineage).mockResolvedValue({
      artifactId: 'plot',
      filename: 'plot.svg',
      originSession: { sessionId: 'source', state: 'active' },
      versions: [version('v2', 2)]
    })
    const loaded = await loadReplaySource(api, { projectId: 'project', sessionId: 'source' })
    expect(loaded.resources.find((item) => item.versionId === 'v1')?.availability).toBe(
      'unavailable'
    )
    expect(loaded.resources.find((item) => item.versionId === 'v1')?.locator).toBeUndefined()
    expect(loaded.resources.find((item) => item.versionId === 'v2')?.availability).toBe('recorded')
  })
})

describe('Replay timeline evidence and visibility', () => {
  it('joins exact execution identities and keeps unknown executions separate', () => {
    const original = session({
      activities: [
        activity('execute', 2, {
          promptMessageId: 'q',
          executionInvocationId: 'invocation'
        })
      ]
    })
    const source = {
      session: original,
      runs: [
        run('matched', { executionInvocationId: 'invocation', promptMessageId: 'q' }),
        run('other', { promptMessageId: 'q' })
      ],
      resources: [],
      issues: []
    }
    const before = structuredClone(source)
    const doc = buildReplayDocument(source)
    const branch = doc.branches[0]
    expect(branch.steps.flatMap((step) => step.runs.map((item) => item.runId))).toEqual([
      'matched',
      'other'
    ])
    expect(
      branch.steps.find((step) => step.activities.length)?.evidence.map((item) => item.kind)
    ).toEqual(['activity', 'notebook-run'])
    expect(branch.steps.find((step) => step.runs[0]?.runId === 'other')?.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'message', id: 'q' })])
    )
    expect(source).toEqual(before)
  })

  it('keeps branch messages, Notebook runs and exact versions on their recorded paths', () => {
    const original = session()
    const graph = createLinearConversationGraph({
      sessionId: original.id,
      messages: original.messages,
      createdAt: 1,
      updatedAt: 8
    })
    const branchId = graph.branches[0].id
    const frameId = graph.rootFrameId
    graph.messages.push({
      ...message('alternative', 'agent', 6, { responseToMessageId: 'q' }),
      agentFrameId: frameId,
      introducedOnBranchId: 'alternative-branch',
      parentMessageId: 'q'
    })
    graph.branches.push({
      id: 'alternative-branch',
      agentFrameId: frameId,
      parentBranchId: branchId,
      forkMessageId: 'q',
      headMessageId: 'alternative',
      createdAt: 6,
      updatedAt: 7
    })
    original.conversationGraph = graph
    const doc = buildReplayDocument({
      session: original,
      runs: [
        run('alternative-run', {
          agentFrameId: frameId,
          messageBranchId: 'alternative-branch',
          promptMessageId: 'q'
        })
      ],
      resources: [resource('v1', { messageId: 'a' }), resource('v2', { messageId: 'alternative' })],
      issues: []
    })
    const main = doc.branches.find((branch) => branch.id === branchId)!
    const alternate = doc.branches.find((branch) => branch.id === 'alternative-branch')!
    expect(main.steps.flatMap((step) => step.resourceIds)).toEqual(['artifact-version:v1'])
    expect(main.steps.flatMap((step) => step.runs)).toEqual([])
    expect(alternate.steps.flatMap((step) => step.resourceIds)).toEqual(['artifact-version:v2'])
    expect(alternate.steps.flatMap((step) => step.runs.map((item) => item.runId))).toEqual([
      'alternative-run'
    ])
    expect(main.steps.map((step) => step.message?.id).filter(Boolean)).toEqual(['q', 'a'])
    expect(alternate.steps.map((step) => step.message?.id).filter(Boolean)).toEqual([
      'q',
      'alternative'
    ])
  })

  it('does not reveal published artifacts at the earlier execution step', () => {
    const doc = buildReplayDocument({
      session: session({
        activities: [
          activity('execute', 2, { executionInvocationId: 'invocation', promptMessageId: 'q' })
        ]
      }),
      runs: [run('r', { executionInvocationId: 'invocation', promptMessageId: 'q' })],
      resources: [resource('v1', { producerRunId: 'r', messageId: 'a' })],
      issues: []
    })
    const branch = doc.branches[0]
    const runStep = branch.steps.find((step) => step.runs.length)!
    expect(projectReplayScene(doc, branch.id, runStep.startMs).visibleResourceIds).toEqual([])
    expect(projectReplayScene(doc, branch.id, branch.durationMs).visibleResourceIds).toEqual([
      'artifact-version:v1'
    ])
    expect(projectReplayScene(doc, branch.id, 0).visibleResourceIds).toEqual([])
  })

  it('keeps a run with a shared prompt but no branch proof in the unattributed lane', () => {
    const original = session()
    const graph = createLinearConversationGraph({
      sessionId: original.id,
      messages: original.messages,
      createdAt: 1,
      updatedAt: 8
    })
    graph.branches.push({
      ...graph.branches[0],
      id: 'another-path',
      parentBranchId: graph.branches[0].id,
      headMessageId: 'q'
    })
    original.conversationGraph = graph
    const doc = buildReplayDocument({
      session: original,
      runs: [run('unbound', { promptMessageId: 'q' })],
      resources: [],
      issues: []
    })
    expect(
      doc.branches
        .filter((branch) => branch.kind === 'conversation')
        .flatMap((branch) => branch.steps.flatMap((step) => step.runs))
    ).toEqual([])
    expect(
      doc.branches.find((branch) => branch.kind === 'unattributed')?.steps[0].runs[0].runId
    ).toBe('unbound')
  })

  it('honors the conversation authority when an activity fork hides a later execution', () => {
    const original = session()
    const graph = createLinearConversationGraph({
      sessionId: original.id,
      messages: original.messages,
      createdAt: 1,
      updatedAt: 8
    })
    const originalBranch = graph.branches[0]
    graph.activities.push({
      ...activity('cutoff', 3, { executionInvocationId: 'cutoff-invocation' }),
      agentFrameId: graph.rootFrameId,
      messageBranchId: originalBranch.id,
      promptMessageId: 'q',
      runtimeSegmentId: graph.runtimeSegments[0].id
    })
    graph.branches.push({
      ...originalBranch,
      id: 'edited-answer',
      parentBranchId: originalBranch.id,
      forkMessageId: 'q',
      forkActivityId: 'cutoff',
      headMessageId: 'q'
    })
    original.conversationGraph = graph
    const doc = buildReplayDocument({
      session: original,
      runs: [
        run('cutoff-run', {
          promptMessageId: 'q',
          messageBranchId: originalBranch.id,
          executionInvocationId: 'cutoff-invocation'
        })
      ],
      resources: [],
      issues: []
    })
    expect(
      doc.branches
        .find((branch) => branch.id === originalBranch.id)
        ?.steps.flatMap((step) => step.runs)
    ).toHaveLength(1)
    expect(
      doc.branches
        .find((branch) => branch.id === 'edited-answer')
        ?.steps.flatMap((step) => step.runs)
    ).toEqual([])
  })

  it('preserves record identities after unrelated earlier messages are added', () => {
    const base = session()
    const doc = buildReplayDocument({ session: base, runs: [], resources: [], issues: [] })
    const expanded = buildReplayDocument({
      session: { ...base, messages: [message('earlier', 'user', 0), ...base.messages] },
      runs: [],
      resources: [],
      issues: []
    })
    expect(expanded.branches[0].steps.slice(1).map((step) => step.id)).toEqual(
      doc.branches[0].steps.map((step) => step.id)
    )
  })

  it('shows file-only and unattributed material without inventing a conversation', () => {
    const doc = buildReplayDocument({
      session: session({ messages: [] }),
      runs: [],
      resources: [resource('v1')],
      issues: []
    })
    const branch = doc.branches.find((item) => item.id === doc.defaultBranchId)!
    expect(branch.kind).toBe('unattributed')
    expect(branch.steps[0].kind).toBe('artifact')
    expect(branch.steps[0].issues).toContainEqual({
      code: 'unattributed-record',
      sourceId: branch.steps[0].id
    })
  })
})

describe('Replay deterministic time projection', () => {
  const document = (): ReplayDocument =>
    buildReplayDocument({ session: session(), runs: [], resources: [], issues: [] })

  it('matches advancing and direct seeking and does not keep future messages when rewound', () => {
    const doc = document()
    const branch = doc.branches[0]
    let clock: ReplayClock = { positionMs: 0, speed: 1, playing: true }
    for (let i = 0; i < 100; i++) clock = advanceReplayClock(clock, 31, branch.durationMs)
    expect(projectReplayScene(doc, branch.id, clock.positionMs)).toEqual(
      projectReplayScene(doc, branch.id, 3100)
    )
    expect(projectReplayScene(doc, branch.id, 3100).visibleSteps).toHaveLength(2)
    expect(projectReplayScene(doc, branch.id, 0).visibleSteps).toHaveLength(1)
    expect(projectReplayScene(doc, branch.id, branch.durationMs).ended).toBe(true)
  })

  it('clamps invalid positions, pauses seeks and stops at the last frame', () => {
    const doc = document()
    const branch = doc.branches[0]
    expect(projectReplayScene(doc, branch.id, NaN).positionMs).toBe(0)
    expect(projectReplayScene(doc, branch.id, -10).stepIndex).toBe(0)
    expect(
      advanceReplayClock(
        { positionMs: 1, playing: true, speed: 2 },
        branch.durationMs,
        branch.durationMs
      )
    ).toEqual({ positionMs: branch.durationMs, playing: false, speed: 2 })
    expect(
      seekReplayClock({ positionMs: 50, playing: true, speed: 1 }, 3, branch.durationMs)
    ).toEqual({ positionMs: 3, playing: false, speed: 1 })
  })

  it('restores stable step offsets and rejects lost anchors', () => {
    const doc = document()
    const scene = projectReplayScene(doc, doc.defaultBranchId, 3100)
    const position = replayPositionAtScene(scene)
    expect(resolveReplayPosition(doc, position)).toBe(3100)
    expect(resolveReplayPosition(doc, { ...position, stepId: 'gone' })).toBeUndefined()
    expect(() => projectReplayScene(doc, 'gone', 1)).toThrow('Replay branch is unavailable')
  })

  it('supports an empty history and never derives elapsed execution from a display duration', () => {
    const doc = buildReplayDocument({
      session: session({ messages: [] }),
      runs: [],
      resources: [],
      issues: []
    })
    expect(projectReplayScene(doc, doc.defaultBranchId, 100)).toMatchObject({
      stepIndex: -1,
      step: undefined,
      ended: true,
      visibleSteps: []
    })
    expect(document().branches[0].steps[0].recordedEndAt).toBeUndefined()
  })

  it('projects input, reconstructed activity and saved results from the same logical clock', () => {
    const doc = buildReplayDocument({
      session: session({
        activities: [
          activity('execute', 2, {
            promptMessageId: 'q',
            executionInvocationId: 'invocation',
            rawInput: { code: 'print(1)' },
            rawOutput: '1'
          })
        ]
      }),
      runs: [run('r', { executionInvocationId: 'invocation', promptMessageId: 'q' })],
      resources: [resource('v1', { messageId: 'a' })],
      issues: []
    })
    const branch = doc.branches[0]
    const execution = branch.steps.find((step) => step.kind === 'notebook')!
    const input = projectReplayScene(doc, branch.id, execution.startMs + execution.durationMs * 0.1)
    const middle = projectReplayScene(
      doc,
      branch.id,
      execution.startMs + execution.durationMs * 0.3
    )
    const result = projectReplayScene(
      doc,
      branch.id,
      execution.startMs + execution.durationMs * 0.6
    )
    expect([input.phase, middle.phase, result.phase]).toEqual(['input', 'activity', 'result'])
    expect(input.showResults).toBe(false)
    const executionIds = new Set(execution.evidence.map((reference) => reference.id))
    expect(
      middle.visibleEvidence
        .filter((ref) => executionIds.has(ref.id))
        .every((ref) => ref.part === 'input')
    ).toBe(true)
    expect(
      middle.visibleEvidence.find((ref) => ref.kind === 'message' && ref.id === 'q')?.part
    ).toBe('record')
    expect(result.showResults).toBe(true)
    expect(result.visibleEvidence.every((ref) => ref.part === 'record')).toBe(true)
    const file = branch.steps.find((step) => step.kind === 'artifact')!
    expect(projectReplayScene(doc, branch.id, file.startMs - 1).visibleResourceIds).toEqual([])
    expect(projectReplayScene(doc, branch.id, file.startMs).visibleResourceIds).toEqual([
      'artifact-version:v1'
    ])
    expect(projectReplayScene(doc, branch.id, execution.startMs).visibleResourceIds).toEqual([])
  })

  it('does not substitute tool updatedAt for a recorded completion time', () => {
    const doc = buildReplayDocument({
      session: session({
        activities: [activity('lookup', 2, { updatedAt: 999999, promptMessageId: 'q' })]
      }),
      runs: [],
      resources: [],
      issues: []
    })
    expect(
      doc.branches[0].steps.find((step) => step.activities.length)?.recordedEndAt
    ).toBeUndefined()
  })
})

describe('historical reviews in replay', () => {
  const review = (id: string, extra: Partial<ReviewWithChecks> = {}): ReviewWithChecks => ({
    id,
    projectId: 'project',
    sessionId: 'source',
    turnMessageId: 'q',
    scope: { turnMessageId: 'q', blocks: [], artifactVersionIds: [] },
    lifecycle: 'complete',
    outcome: 'flagged',
    model: 'archived-model',
    reviewerLog: [],
    createdAt: 6,
    updatedAt: 8,
    checks: [],
    ...extra
  })
  it('keeps reviews on their recorded branch and puts ambiguous shared-turn reviews in related material', () => {
    const original = session()
    const graph = createLinearConversationGraph({
      sessionId: original.id,
      messages: original.messages,
      createdAt: 1,
      updatedAt: 8
    })
    const mainId = graph.branches[0].id
    graph.messages.push({
      ...message('alternative', 'agent', 6, { responseToMessageId: 'q' }),
      agentFrameId: graph.rootFrameId,
      introducedOnBranchId: 'alternate',
      parentMessageId: 'q'
    })
    graph.branches.push({
      id: 'alternate',
      agentFrameId: graph.rootFrameId,
      parentBranchId: mainId,
      forkMessageId: 'q',
      headMessageId: 'alternative',
      createdAt: 6,
      updatedAt: 7
    })
    original.conversationGraph = graph
    const exact = review('exact', {
      scope: {
        turnMessageId: 'q',
        agentFrameId: graph.rootFrameId,
        messageBranchId: mainId,
        blocks: [
          { id: 'answer', kind: 'message', sourceId: 'a', blockIndex: 0, contentHash: 'hash' }
        ],
        artifactVersionIds: []
      }
    })
    const missing = review('missing', {
      scope: { ...exact.scope, messageBranchId: 'deleted-branch' }
    })
    const doc = buildReplayDocument({
      session: original,
      runs: [],
      resources: [],
      issues: [],
      reviews: [exact, review('legacy'), missing]
    })
    expect(
      doc.branches
        .find((branch) => branch.id === mainId)!
        .steps.map((step) => step.review?.id)
        .filter(Boolean)
    ).toEqual(['exact'])
    expect(
      doc.branches.find((branch) => branch.id === 'alternate')!.steps.some((step) => step.review)
    ).toBe(false)
    expect(
      doc.branches
        .find((branch) => branch.kind === 'unattributed')!
        .steps.map((step) => step.review?.id)
    ).toEqual(['legacy', 'missing'])
    const branch = doc.branches[0]
    const step = branch.steps.find((step) => step.review)!
    expect(branch.steps.indexOf(step)).toBeGreaterThan(
      branch.steps.findIndex((step) => step.message?.id === 'a')
    )
    expect(
      projectReplayScene(doc, branch.id, step.startMs - 1).visibleEvidence.some(
        (ref) => ref.kind === 'review'
      )
    ).toBe(false)
    expect(
      projectReplayScene(doc, branch.id, step.startMs).visibleEvidence.some(
        (ref) => ref.kind === 'review'
      )
    ).toBe(true)
  })
  it('preserves separate review rounds and reports a failed reader without blocking the transcript', async () => {
    const api: ReplayReaderApi = {
      sessions: { loadOne: vi.fn().mockResolvedValue(session()) },
      notebook: { getReference: vi.fn().mockResolvedValue(null), state: vi.fn() },
      artifacts: { getLineage: vi.fn() },
      reviewer: { getForSession: vi.fn().mockRejectedValue(new Error('missing')) }
    }
    const unavailable = await loadReplayDocument(api, { projectId: 'project', sessionId: 'source' })
    expect(unavailable.issues).toContainEqual({ code: 'review-unavailable' })
    expect(unavailable.branches[0].steps.some((step) => step.message?.id === 'a')).toBe(true)
    const doc = buildReplayDocument({
      session: session(),
      runs: [],
      resources: [],
      issues: [],
      reviews: [review('first'), review('second', { outcome: 'pass', createdAt: 9 })]
    })
    expect(
      doc.branches[0].steps.filter((step) => step.review).map((step) => step.review?.outcome)
    ).toEqual(['flagged', 'pass'])
  })
})

it('loads large timelines through one compact index read without fetching output history pages', async () => {
  const api = apiFor()
  const rows = Array.from({ length: 10000 }, (_, i) => ({
    runId: `run-${i}`,
    cellId: `cell-${i}`,
    source: 'agent' as const,
    kernelKind: 'python' as const,
    status: 'completed' as const,
    startedAt: i,
    endedAt: i + 1,
    scriptCharacters: 100000,
    hasOutput: true
  }))
  api.notebook.runIndex = vi.fn().mockResolvedValue(rows)
  const loaded = await loadReplaySource(api, { projectId: 'project', sessionId: 'source' })
  expect(loaded.runs).toHaveLength(10000)
  expect(api.notebook.runIndex).toHaveBeenCalledTimes(1)
  expect(api.notebook.state).not.toHaveBeenCalled()
  expect(api.notebook.getReference).not.toHaveBeenCalled()
  expect(JSON.stringify(loaded.runs)).not.toContain('stdout')
})
