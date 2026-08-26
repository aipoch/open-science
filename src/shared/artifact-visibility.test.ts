import { describe, expect, it } from 'vitest'

import { normalizeSessionFile, type PersistedChatSession } from './session-persistence'
import { projectRootArtifactVisibility } from './artifact-visibility'

const session = (): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Artifacts',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  filesRevision: 1,
  createdAt: 1,
  updatedAt: 10,
  conversationGraph: {
    schemaVersion: 1,
    rootFrameId: 'root-frame',
    activeFrameId: 'root-frame',
    frames: [
      {
        id: 'root-frame',
        originBindingState: 'root',
        kind: 'root',
        status: 'completed',
        activeBranchId: 'root-main',
        createdAt: 1
      },
      {
        id: 'child-frame',
        parentFrameId: 'root-frame',
        originMessageId: 'root-turn-1',
        originBindingState: 'validated',
        kind: 'delegate',
        status: 'completed',
        activeBranchId: 'child-main',
        createdAt: 3
      }
    ],
    branches: [
      {
        id: 'root-main',
        agentFrameId: 'root-frame',
        headMessageId: 'root-turn-2',
        createdAt: 1,
        updatedAt: 7
      },
      {
        id: 'root-other',
        agentFrameId: 'root-frame',
        headMessageId: 'root-other-turn',
        createdAt: 1,
        updatedAt: 8
      },
      {
        id: 'child-main',
        agentFrameId: 'child-frame',
        headMessageId: 'child-answer-2',
        createdAt: 3,
        updatedAt: 9
      }
    ],
    messages: [
      {
        id: 'root-turn-1',
        role: 'user',
        content: 'first',
        status: 'complete',
        eventIds: [],
        agentFrameId: 'root-frame',
        introducedOnBranchId: 'root-main',
        revisionRootMessageId: 'root-turn-1',
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'root-turn-2',
        role: 'user',
        content: 'again',
        status: 'complete',
        eventIds: [],
        agentFrameId: 'root-frame',
        introducedOnBranchId: 'root-main',
        parentMessageId: 'root-turn-1',
        revisionRootMessageId: 'root-turn-2',
        createdAt: 6,
        updatedAt: 6
      },
      {
        id: 'root-other-turn',
        role: 'user',
        content: 'fork',
        status: 'complete',
        eventIds: [],
        agentFrameId: 'root-frame',
        introducedOnBranchId: 'root-other',
        revisionRootMessageId: 'root-other-turn',
        createdAt: 2,
        updatedAt: 2
      },
      {
        id: 'child-prompt-1',
        role: 'user',
        content: 'first task',
        status: 'complete',
        eventIds: [],
        delegatedCallerSource: { rootMessageId: 'root-turn-1', toolInvocationId: 'invoke-1' },
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-main',
        revisionRootMessageId: 'child-prompt-1',
        createdAt: 3,
        updatedAt: 3
      },
      {
        id: 'child-answer-1',
        role: 'agent',
        content: 'first result',
        status: 'complete',
        eventIds: [],
        artifactIds: ['version-1'],
        responseToMessageId: 'child-prompt-1',
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-main',
        parentMessageId: 'child-prompt-1',
        createdAt: 4,
        updatedAt: 4
      },
      {
        id: 'child-prompt-2',
        role: 'user',
        content: 'second task',
        status: 'complete',
        eventIds: [],
        delegatedCallerSource: { rootMessageId: 'root-turn-2', toolInvocationId: 'invoke-2' },
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-main',
        parentMessageId: 'child-answer-1',
        revisionRootMessageId: 'child-prompt-2',
        createdAt: 7,
        updatedAt: 7
      },
      {
        id: 'child-answer-2',
        role: 'agent',
        content: 'second result',
        status: 'complete',
        eventIds: [],
        artifactIds: ['version-2', 'version-2'],
        responseToMessageId: 'child-prompt-2',
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-main',
        parentMessageId: 'child-prompt-2',
        createdAt: 9,
        updatedAt: 9
      }
    ],
    activities: [
      {
        id: 'invoke-1',
        kind: 'tool',
        title: 'delegate',
        status: 'completed',
        sortIndex: 1,
        eventIds: [],
        createdAt: 2,
        updatedAt: 2,
        agentFrameId: 'root-frame',
        messageBranchId: 'root-main',
        promptMessageId: 'root-turn-1',
        runtimeSegmentId: 'root-runtime'
      },
      {
        id: 'invoke-2',
        kind: 'tool',
        title: 'send_message',
        status: 'completed',
        sortIndex: 2,
        eventIds: [],
        createdAt: 6,
        updatedAt: 6,
        agentFrameId: 'root-frame',
        messageBranchId: 'root-main',
        promptMessageId: 'root-turn-2',
        runtimeSegmentId: 'root-runtime'
      }
    ],
    activityGroups: [],
    runtimeSegments: [
      { id: 'root-runtime', agentFrameId: 'root-frame', frameworkId: 'codex', startedAt: 1 }
    ]
  }
})

describe('root Artifact visibility projection', () => {
  it('restores a trusted Notebook delegate invocation before projecting its child Artifact', () => {
    const durable = session()
    const graph = durable.conversationGraph!
    const source = 'notebook-run-42-1\u0000delegate\u00001'
    graph.activities = graph.activities.filter(({ id }) => id !== 'invoke-2')
    const rootPrompt = graph.messages.find(({ id }) => id === 'root-turn-2')!
    rootPrompt.runtimeSegmentId = 'root-runtime'
    const childPrompt = graph.messages.find(({ id }) => id === 'child-prompt-2')!
    childPrompt.delegatedCallerSource = {
      rootMessageId: rootPrompt.id,
      toolInvocationId: source
    }

    const restored = normalizeSessionFile(durable)!
    const activity = restored.conversationGraph!.activities.find(({ id }) => id === source)

    expect(activity).toMatchObject({
      title: 'Delegate subagent',
      status: 'completed',
      agentFrameId: 'root-frame',
      messageBranchId: 'root-main',
      promptMessageId: 'root-turn-2',
      runtimeSegmentId: 'root-runtime'
    })
    expect(projectRootArtifactVisibility(restored, 'root-main')).toMatchObject({
      placements: [
        expect.objectContaining({
          rootMessageId: 'root-turn-1',
          artifactVersionId: 'version-1'
        }),
        expect.objectContaining({
          rootMessageId: 'root-turn-2',
          toolInvocationId: source,
          artifactVersionId: 'version-2'
        })
      ],
      diagnostics: []
    })
  })

  it('places exact child-owned versions at each durable root invocation without mutating ownership', () => {
    const durable = session()
    const before = structuredClone(durable)

    const result = projectRootArtifactVisibility(durable, 'root-main')

    expect(result.placements).toEqual([
      {
        rootMessageId: 'root-turn-1',
        toolInvocationId: 'invoke-1',
        artifactVersionId: 'version-1',
        ownerMessageId: 'child-answer-1',
        childPromptMessageId: 'child-prompt-1',
        childFrameId: 'child-frame'
      },
      {
        rootMessageId: 'root-turn-2',
        toolInvocationId: 'invoke-2',
        artifactVersionId: 'version-2',
        ownerMessageId: 'child-answer-2',
        childPromptMessageId: 'child-prompt-2',
        childFrameId: 'child-frame'
      }
    ])
    expect(result.diagnostics).toEqual([])
    expect(durable).toEqual(before)
    expect(
      durable.conversationGraph?.messages.find(({ id }) => id === 'root-turn-1')?.artifactIds
    ).toBeUndefined()
  })

  it('fails closed when the requested root branch cannot prove the caller invocation', () => {
    const result = projectRootArtifactVisibility(session(), 'root-other')
    expect(result.placements).toEqual([])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'caller-message-not-on-root-branch' })
      ])
    )
  })

  it('keeps an ancestor invocation visible on a descendant root branch but not a sibling', () => {
    const durable = session()
    const graph = durable.conversationGraph!
    graph.branches.push({
      id: 'root-descendant',
      agentFrameId: 'root-frame',
      parentBranchId: 'root-main',
      forkMessageId: 'root-turn-1',
      headMessageId: 'root-descendant-turn',
      createdAt: 10,
      updatedAt: 10
    })
    graph.messages.push({
      id: 'root-descendant-turn',
      role: 'user',
      content: 'continue from first',
      status: 'complete',
      eventIds: [],
      agentFrameId: 'root-frame',
      introducedOnBranchId: 'root-descendant',
      parentMessageId: 'root-turn-1',
      revisionRootMessageId: 'root-descendant-turn',
      createdAt: 10,
      updatedAt: 10
    })

    expect(projectRootArtifactVisibility(durable, 'root-descendant').placements).toEqual([
      expect.objectContaining({ artifactVersionId: 'version-1', toolInvocationId: 'invoke-1' })
    ])
    expect(projectRootArtifactVisibility(durable, 'root-other').placements).toEqual([])
  })

  it('keeps historical child-branch owners visible and rejects incomplete owners without moving ownership', () => {
    const durable = session()
    const graph = durable.conversationGraph!
    graph.branches.push({
      id: 'child-new',
      agentFrameId: 'child-frame',
      headMessageId: 'child-new-prompt',
      createdAt: 10,
      updatedAt: 10
    })
    graph.messages.push({
      id: 'child-new-prompt',
      role: 'user',
      content: 'new branch',
      status: 'complete',
      eventIds: [],
      delegatedCallerSource: { rootMessageId: 'root-turn-2', toolInvocationId: 'invoke-2' },
      agentFrameId: 'child-frame',
      introducedOnBranchId: 'child-new',
      revisionRootMessageId: 'child-new-prompt',
      createdAt: 10,
      updatedAt: 10
    })
    graph.frames.find(({ id }) => id === 'child-frame')!.activeBranchId = 'child-new'
    graph.messages.push({
      id: 'incomplete-owner',
      role: 'agent',
      content: 'partial',
      status: 'streaming',
      eventIds: [],
      artifactIds: ['version-partial'],
      responseToMessageId: 'child-new-prompt',
      agentFrameId: 'child-frame',
      introducedOnBranchId: 'child-new',
      parentMessageId: 'child-new-prompt',
      createdAt: 11,
      updatedAt: 11
    })
    graph.branches.find(({ id }) => id === 'child-new')!.headMessageId = 'incomplete-owner'

    expect(projectRootArtifactVisibility(durable, 'root-main').placements).toEqual([
      expect.objectContaining({ artifactVersionId: 'version-1', ownerMessageId: 'child-answer-1' }),
      expect.objectContaining({ artifactVersionId: 'version-2', ownerMessageId: 'child-answer-2' })
    ])
    expect(graph.messages.find(({ id }) => id === 'incomplete-owner')?.artifactIds).toEqual([
      'version-partial'
    ])
  })

  it('orders multiple children, invocations, and versions by root Turn then invocation while deduplicating exact versions', () => {
    const durable = session()
    const graph = durable.conversationGraph!
    graph.activities.push({ ...graph.activities[0], id: 'invoke-1b', sortIndex: 3 })
    graph.frames.push({
      id: 'child-b',
      parentFrameId: 'root-frame',
      originMessageId: 'root-turn-1',
      originBindingState: 'validated',
      kind: 'delegate',
      status: 'completed',
      activeBranchId: 'child-b-branch',
      createdAt: 3
    })
    graph.branches.push({
      id: 'child-b-branch',
      agentFrameId: 'child-b',
      headMessageId: 'child-b-answer',
      createdAt: 3,
      updatedAt: 5
    })
    graph.messages.push(
      {
        id: 'child-b-prompt',
        role: 'user',
        content: 'parallel',
        status: 'complete',
        eventIds: [],
        delegatedCallerSource: { rootMessageId: 'root-turn-1', toolInvocationId: 'invoke-1b' },
        agentFrameId: 'child-b',
        introducedOnBranchId: 'child-b-branch',
        revisionRootMessageId: 'child-b-prompt',
        createdAt: 3,
        updatedAt: 3
      },
      {
        id: 'child-b-answer',
        role: 'agent',
        content: 'parallel result',
        status: 'complete',
        eventIds: [],
        artifactIds: ['version-b2', 'version-b1', 'version-b1'],
        responseToMessageId: 'child-b-prompt',
        agentFrameId: 'child-b',
        introducedOnBranchId: 'child-b-branch',
        parentMessageId: 'child-b-prompt',
        createdAt: 5,
        updatedAt: 5
      }
    )

    expect(
      projectRootArtifactVisibility(durable, 'root-main').placements.map(
        ({ toolInvocationId, artifactVersionId }) => [toolInvocationId, artifactVersionId]
      )
    ).toEqual([
      ['invoke-1', 'version-1'],
      ['invoke-1b', 'version-b1'],
      ['invoke-1b', 'version-b2'],
      ['invoke-2', 'version-2']
    ])
  })

  it('fails closed for missing prompt source, wrong invocation lineage, and ambiguous legacy bindings', () => {
    const missing = session()
    delete missing.conversationGraph!.messages.find(({ id }) => id === 'child-prompt-2')!
      .delegatedCallerSource
    expect(projectRootArtifactVisibility(missing, 'root-main')).toMatchObject({
      placements: [expect.objectContaining({ artifactVersionId: 'version-1' })],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'legacy-source-unavailable', messageId: 'child-prompt-2' })
      ])
    })

    const wrongInvocation = session()
    wrongInvocation.conversationGraph!.messages.find(
      ({ id }) => id === 'child-prompt-2'
    )!.delegatedCallerSource = { rootMessageId: 'root-turn-2', toolInvocationId: 'invoke-1' }
    expect(projectRootArtifactVisibility(wrongInvocation, 'root-main').diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'caller-invocation-not-on-root-turn' })
      ])
    )

    const ambiguousLegacy = session()
    const firstPrompt = ambiguousLegacy.conversationGraph!.messages.find(
      ({ id }) => id === 'child-prompt-1'
    )!
    delete firstPrompt.delegatedCallerSource
    ambiguousLegacy.conversationGraph!.activities.push({
      ...ambiguousLegacy.conversationGraph!.activities[0],
      id: 'another-invoke'
    })
    expect(projectRootArtifactVisibility(ambiguousLegacy, 'root-main')).toMatchObject({
      placements: [expect.objectContaining({ artifactVersionId: 'version-2' })],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'legacy-source-unavailable', messageId: 'child-prompt-1' })
      ])
    })
  })

  it('allows only a uniquely proven initial legacy dispatch and reports invalid graph lineage', () => {
    const legacy = session()
    const firstPrompt = legacy.conversationGraph!.messages.find(
      ({ id }) => id === 'child-prompt-1'
    )!
    delete firstPrompt.delegatedCallerSource
    legacy.conversationGraph!.activities[0].rawOutput = { frameId: 'child-frame' }
    expect(projectRootArtifactVisibility(legacy, 'root-main').placements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactVersionId: 'version-1', toolInvocationId: 'invoke-1' })
      ])
    )

    const substringOnly = session()
    const substringPrompt = substringOnly.conversationGraph!.messages.find(
      ({ id }) => id === 'child-prompt-1'
    )!
    delete substringPrompt.delegatedCallerSource
    substringOnly.conversationGraph!.activities[0].rawOutput = {
      message: 'unrelated-child-frame-suffix'
    }
    expect(projectRootArtifactVisibility(substringOnly, 'root-main')).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'legacy-source-unavailable', messageId: 'child-prompt-1' })
      ])
    })

    const invalid = session()
    invalid.conversationGraph!.frames.find(({ id }) => id === 'child-frame')!.parentFrameId =
      'missing-parent'
    expect(projectRootArtifactVisibility(invalid, 'root-main')).toEqual({
      placements: [],
      diagnostics: [{ code: 'invalid-conversation-graph' }]
    })
  })

  it('fails closed when an Artifact owner path crosses sibling child Branches', () => {
    const durable = session()
    const graph = durable.conversationGraph!
    const owner = graph.messages.find(({ id }) => id === 'child-answer-2')!
    owner.introducedOnBranchId = 'child-orphan-branch'
    owner.parentMessageId = 'child-prompt-1'
    graph.branches.find(({ id }) => id === 'child-main')!.headMessageId = 'child-prompt-2'
    graph.branches.push({
      id: 'child-orphan-branch',
      agentFrameId: 'child-frame',
      headMessageId: 'child-answer-2',
      createdAt: 8,
      updatedAt: 8
    })
    expect(projectRootArtifactVisibility(durable, 'root-main')).toEqual({
      placements: [],
      diagnostics: [{ code: 'invalid-conversation-graph' }]
    })
  })

  it('rejects a responseTo prompt that disagrees with the owner parent ancestry', () => {
    const durable = session()
    const owner = durable.conversationGraph!.messages.find(({ id }) => id === 'child-answer-2')!
    owner.responseToMessageId = 'child-prompt-1'

    expect(projectRootArtifactVisibility(durable, 'root-main')).toMatchObject({
      placements: [expect.objectContaining({ artifactVersionId: 'version-1' })],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'owner-without-child-prompt', messageId: 'child-answer-2' })
      ])
    })
  })
})
