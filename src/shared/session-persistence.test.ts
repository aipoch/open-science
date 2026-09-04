import { describe, expect, it } from 'vitest'

import { MAX_ACP_SESSION_IMAGE_BYTES } from './acp'
import { MAX_ELICITATION_OPTIONS_PER_FIELD } from './elicitation'

import {
  SESSION_FILE_VERSION,
  collectSessionReferences,
  createSessionFile,
  ConversationGraphMaterializationError,
  decodeSessionFile,
  materializeSessionConversationGraph,
  isComputeJobCompletionAttribution,
  isReviewerCorrectionAttribution,
  sanitizeActivityGroup,
  normalizeSessionFile,
  sanitizeMessageAttribution,
  sanitizeMessageImages,
  sanitizeSessionPdfContext,
  sanitizeSessionRuntimeContext,
  sanitizeToolActivity,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedSideChat,
  type PersistedToolActivity,
  type SessionPermissionRuntimeContext,
  type SessionPlanRuntimeContext
} from './session-persistence'
import {
  activateConversationBranch,
  createLinearConversationGraph,
  forkConversationAfterActivity,
  resolveActiveConversationActivities,
  synchronizeActiveConversationActivities
} from './conversation-graph'
import type { ActivePlanProjection } from './session-plan/contract'

const createSessionWithActivity = (activity: unknown): Record<string, unknown> => ({
  id: 'session-1',
  projectId: 'project-a',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  activities: [activity],
  createdAt: 1,
  updatedAt: 1
})

describe('Session file envelope versions', () => {
  const legacySession = (): Record<string, unknown> => createSessionWithActivity(undefined)

  it.each([
    ['a bare historical Session', () => legacySession()],
    ['a v1 envelope', () => ({ version: 1, session: legacySession() })],
    ['the current envelope', () => ({ version: SESSION_FILE_VERSION, session: legacySession() })]
  ])('accepts %s', (_label, createValue) => {
    const decoded = decodeSessionFile(createValue())

    expect(decoded.status).toBe('ok')
    expect(decoded.status === 'ok' ? decoded.session.id : undefined).toBe('session-1')
  })

  it('rejects a future envelope before unknown authority can be discarded', () => {
    const futureFile = {
      version: SESSION_FILE_VERSION + 1,
      payload: { futureAuthority: { revision: 1 } }
    }

    expect(decodeSessionFile(futureFile)).toEqual({ status: 'unsupported-version' })
    expect(normalizeSessionFile(futureFile)).toBeUndefined()
  })

  it.each([undefined, 0, '2', 2.5])('treats an envelope with version %j as corrupt', (version) => {
    const value = { version, session: legacySession() }

    expect(decodeSessionFile(value)).toEqual({ status: 'invalid' })
    expect(normalizeSessionFile(value)).toBeUndefined()
  })

  it('restores historical and malformed whole-Session revisions as zero', () => {
    expect(normalizeSessionFile(legacySession())?.revision).toBe(0)
    expect(normalizeSessionFile({ ...legacySession(), revision: 7 })?.revision).toBe(7)
    expect(normalizeSessionFile({ ...legacySession(), revision: -1 })?.revision).toBe(0)
    expect(normalizeSessionFile({ ...legacySession(), revision: '7' })?.revision).toBe(0)
  })

  it('restores a valid Compute concurrency limit and keeps historical Sessions unlimited', () => {
    expect(normalizeSessionFile(legacySession())?.computeConcurrencyLimit).toBeUndefined()
    expect(
      normalizeSessionFile({ ...legacySession(), computeConcurrencyLimit: 1 })
        ?.computeConcurrencyLimit
    ).toBe(1)
    expect(
      normalizeSessionFile({ ...legacySession(), computeConcurrencyLimit: 500 })
        ?.computeConcurrencyLimit
    ).toBe(500)
  })

  it.each([0, 501, 1.5, '1'])('rejects malformed Compute concurrency limit %j', (limit) => {
    expect(
      normalizeSessionFile({ ...legacySession(), computeConcurrencyLimit: limit })
    ).toBeUndefined()
  })

  it('redacts credentials while decoding a historical Session file', () => {
    const activity = normalizeSessionFile(
      createSessionWithActivity({
        id: 'tool-secret',
        status: 'completed',
        title: 'curl https://example.test/data?token=test-persisted-title-secret',
        rawInput: {
          query: 'safe input',
          connection: {
            apiKey: 'test-api-key-secret',
            accessKey: 'test-persisted-structured-access-key-secret'
          },
          command: 'provider --access-key test-persisted-cli-access-key-secret'
        },
        rawOutput: {
          result: 'safe output',
          authorization: 'Bearer test-authorization-secret'
        }
      })
    )?.activities?.[0]

    expect(activity?.rawInput).toMatchObject({
      query: 'safe input',
      connection: { apiKey: '[redacted]', accessKey: '[redacted]' },
      command: 'provider --access-key [redacted]'
    })
    expect(activity?.rawOutput).toMatchObject({
      result: 'safe output',
      authorization: '[redacted]'
    })
    expect(activity?.title).toContain('[redacted]')
    expect(JSON.stringify(activity)).not.toContain('test-persisted-title-secret')
    expect(JSON.stringify(activity)).not.toContain('test-api-key-secret')
    expect(JSON.stringify(activity)).not.toContain('test-persisted-structured-access-key-secret')
    expect(JSON.stringify(activity)).not.toContain('test-persisted-cli-access-key-secret')
    expect(JSON.stringify(activity)).not.toContain('test-authorization-secret')
  })
})

describe('Session Specialist binding persistence', () => {
  it('restores only an explicit pending marker and keeps historical files applied by default', () => {
    const pending = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      specialistId: 'specialist-new',
      specialistBindingPending: true
    })
    const historical = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      specialistId: 'specialist-old'
    })
    const malformed = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      specialistId: 'specialist-old',
      specialistBindingPending: 'yes'
    })

    expect(pending).toMatchObject({
      specialistId: 'specialist-new',
      specialistBindingPending: true
    })
    expect(historical?.specialistBindingPending).toBeUndefined()
    expect(malformed?.specialistBindingPending).toBeUndefined()
  })
})

describe('artifact persistence', () => {
  it('preserves valid creation timestamps while accepting historical artifacts without one', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      artifacts: [
        {
          id: 'artifact-current',
          kind: 'managed-file',
          path: '/workspace/current.md',
          createdAt: 1_723_000_000_000
        },
        {
          id: 'artifact-historical',
          kind: 'managed-file',
          path: '/workspace/historical.md'
        },
        {
          id: 'artifact-invalid',
          kind: 'managed-file',
          path: '/workspace/invalid.md',
          createdAt: -1
        }
      ]
    })

    expect(restored?.artifacts).toEqual([
      {
        id: 'artifact-current',
        kind: 'managed-file',
        path: '/workspace/current.md',
        createdAt: 1_723_000_000_000
      },
      {
        id: 'artifact-historical',
        kind: 'managed-file',
        path: '/workspace/historical.md'
      },
      {
        id: 'artifact-invalid',
        kind: 'managed-file',
        path: '/workspace/invalid.md'
      }
    ])
  })
})

const getRestoredActivities = (session: unknown): PersistedChatSession['activities'] =>
  normalizeSessionFile(session)?.activities

const createOpenToolActivity = (
  id = 'tool-1',
  overrides: Partial<PersistedToolActivity> = {}
): PersistedToolActivity => ({
  id,
  kind: 'tool',
  title: 'Run npm test',
  status: 'in_progress',
  sortIndex: 1,
  eventIds: [`${id}-started`],
  promptMessageId: 'prompt-1',
  createdAt: 2,
  updatedAt: 2,
  ...overrides
})

const createContinuingPermissionFile = (
  activities: PersistedToolActivity[],
  originatingPromptMessageId = 'prompt-1'
): ReturnType<typeof createSessionFile> =>
  createSessionFile({
    ...(createSessionWithActivity(undefined) as PersistedChatSession),
    activities,
    status: 'running',
    activeRun: { promptMessageId: 'prompt-1', startedAt: 2 },
    messages: [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Run the tests',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    runtimeContext: {
      version: 1,
      revision: 4,
      permission: {
        state: 'continuing',
        request: {
          requestId: 'permission-1',
          sessionId: 'session-1',
          toolCallId: 'tool-1',
          title: 'Run npm test',
          isMcp: true,
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
        },
        originatingPromptMessageId,
        fingerprint: 'a'.repeat(64),
        createdAt: 2
      }
    }
  })

const createRuntimePlan = (): SessionPlanRuntimeContext => ({
  artifactId: 'plan-1',
  artifactVersionId: 'plan-version-1',
  artifactChecksum: 'a'.repeat(64),
  originatingPromptMessageId: 'prompt-plan-1',
  approval: 'pending',
  stepStatuses: {}
})

const createHistoricalPlan = (): ActivePlanProjection => ({
  artifactId: 'artifact-plan-history',
  artifactVersionId: 'version-plan-history',
  artifactChecksum: 'b'.repeat(64),
  originatingPromptMessageId: 'prompt-plan-history',
  revision: 3,
  approval: 'approved',
  lifecycle: 'completed',
  requiresExplicitContinuation: false,
  document: {
    schema_version: 1,
    task_summary: 'Analyze the branched dataset',
    phases: [
      {
        name: 'Analysis',
        delegations: [
          {
            name: 'Primary agent',
            steps: [{ title: 'Analyze data', description: 'Produce the result.' }]
          }
        ]
      }
    ],
    desired_outputs: ['Analysis report'],
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: { 'Analyze data': { status: 'completed', updatedAt: 4 } },
  stepStates: { 'Analyze data': { status: 'completed' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 1, inProgress: 0 }
})

describe('conversation graph materialization diagnostics', () => {
  it('preserves a conversation written by a not-yet-known Agent framework', () => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'message-1',
        role: 'user',
        content: 'Persist me',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
    const conversationGraph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages,
      createdAt: 1,
      updatedAt: 1
    })
    conversationGraph.runtimeSegments[0].frameworkId = 'future-acp'
    conversationGraph.runtimeSegments[0].providerId = 'provider-1'

    const decoded = decodeSessionFile({
      version: SESSION_FILE_VERSION,
      session: {
        ...createSessionWithActivity(undefined),
        messages,
        conversationGraph
      }
    })

    expect(decoded).toMatchObject({
      status: 'ok',
      session: {
        conversationGraph: {
          runtimeSegments: [{ frameworkId: 'future-acp', providerId: 'provider-1' }]
        }
      }
    })
  })

  it('writes a canonical graph while retaining flat messages as the active projection', () => {
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-a',
      title: 'Historical flat session',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Persist me',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1
    }

    const written = createSessionFile(session)

    expect(written.version).toBe(SESSION_FILE_VERSION)
    expect(written.session.conversationGraph.schemaVersion).toBe(1)
    expect(written.session.messages).toEqual(session.messages)
    expect(written.session.conversationGraph.messages).toEqual([
      expect.objectContaining({ id: 'message-1', content: 'Persist me' })
    ])
  })

  it('identifies message synchronization failures without exposing the raw graph error', () => {
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-a',
      title: 'Session',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      conversationGraph: createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [],
        createdAt: 1,
        updatedAt: 1
      }),
      createdAt: 1,
      updatedAt: 1
    }
    session.conversationGraph!.activeFrameId = 'missing-private-frame-id'

    expect(() => materializeSessionConversationGraph(session)).toThrowError(
      expect.objectContaining<Partial<ConversationGraphMaterializationError>>({
        name: 'ConversationGraphMaterializationError',
        phase: 'messages',
        message: 'Conversation graph materialization failed.'
      })
    )
  })
})

describe('session branch source persistence', () => {
  it('restores a complete source snapshot without inferring one for historical sessions', () => {
    const historical = createSessionWithActivity(undefined)
    const restored = normalizeSessionFile({
      ...historical,
      activities: undefined,
      branchSource: {
        sessionId: 'source-session',
        agentFrameId: 'source-frame',
        messageBranchId: 'source-branch',
        headMessageId: 'source-head'
      }
    })

    expect(restored?.branchSource).toEqual({
      sessionId: 'source-session',
      agentFrameId: 'source-frame',
      messageBranchId: 'source-branch',
      headMessageId: 'source-head'
    })
    expect(normalizeSessionFile(historical)?.branchSource).toBeUndefined()
  })

  it('discards malformed or empty source snapshots', () => {
    const base = { ...createSessionWithActivity(undefined), activities: undefined }

    expect(
      normalizeSessionFile({ ...base, branchSource: { sessionId: '' } })?.branchSource
    ).toBeUndefined()
    expect(
      normalizeSessionFile({
        ...base,
        branchSource: { sessionId: 'source-session', messageBranchId: 42 }
      })?.branchSource
    ).toBeUndefined()
  })
})

describe('branch Plan history persistence', () => {
  it('restores only branch-bound projections and recomputes their display state', () => {
    const valid = createHistoricalPlan()
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      planHistoryProjections: [
        { ...valid, originatingPromptMessageId: undefined },
        {
          ...valid,
          stepStates: { 'Analyze data': { status: 'not_started' } },
          counts: { phases: 99, delegations: 99, steps: 99, completed: 0, inProgress: 0 }
        }
      ]
    })

    expect(restored?.planHistoryProjections).toEqual([valid])
  })

  it('bounds aggregate history size while retaining the newest exact versions', () => {
    const history = Array.from({ length: 5 }, (_, index) => {
      const version = index + 1
      const plan = createHistoricalPlan()
      return {
        ...plan,
        artifactVersionId: `version-${version}`,
        originatingPromptMessageId: `prompt-${version}`,
        document: {
          ...plan.document,
          phases: [
            {
              ...plan.document.phases[0],
              delegations: [
                {
                  ...plan.document.phases[0].delegations[0],
                  steps: [
                    {
                      title: 'Analyze data',
                      description: `${version}${'x'.repeat(409_999)}`
                    }
                  ]
                }
              ]
            }
          ]
        }
      }
    })

    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      planHistoryProjections: history
    })

    expect(restored?.planHistoryProjections?.map((plan) => plan.artifactVersionId)).toEqual([
      'version-2',
      'version-3',
      'version-4',
      'version-5'
    ])
  })
})

describe('message attribution persistence', () => {
  it('recognizes only the closed Reviewer Correction attribution variant', () => {
    expect(
      isReviewerCorrectionAttribution({
        kind: 'application',
        feature: 'reviewer',
        purpose: 'correction',
        causeReviewId: 'review-1'
      })
    ).toBe(true)
    expect(
      isReviewerCorrectionAttribution({
        kind: 'application',
        feature: 'reviewer',
        purpose: 'correction',
        causeReviewId: 'review-1',
        rendererClaim: true
      })
    ).toBe(false)
    expect(isReviewerCorrectionAttribution(undefined)).toBe(false)
  })

  it('preserves a Reviewer Correction attribution through Session JSON and Conversation Graph projection', () => {
    const session = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      messages: [
        {
          id: 'correction-1',
          role: 'user',
          content: '[Auditor] Correct the unsupported claim.',
          status: 'complete',
          eventIds: ['event-1'],
          attribution: {
            kind: 'application',
            feature: 'reviewer',
            purpose: 'correction',
            causeReviewId: 'review-1'
          },
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })

    expect(session?.messages[0]?.attribution).toEqual({
      kind: 'application',
      feature: 'reviewer',
      purpose: 'correction',
      causeReviewId: 'review-1'
    })
    expect(
      session &&
        materializeSessionConversationGraph(session).conversationGraph?.messages[0]?.attribution
    ).toEqual({
      kind: 'application',
      feature: 'reviewer',
      purpose: 'correction',
      causeReviewId: 'review-1'
    })
  })

  it('preserves a Compute completion delivery identity through Session JSON and Conversation Graph projection', () => {
    const session = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      messages: [
        {
          id: 'compute-delivery-message-1',
          role: 'user',
          content: 'Analyze completed remote jobs.',
          status: 'complete',
          eventIds: [],
          attribution: {
            kind: 'application',
            feature: 'compute',
            purpose: 'job-completion-analysis',
            deliveryKey: 'compute_done:session-1:job-1,job-2',
            jobIds: ['job-1', 'job-2']
          },
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })

    const attribution = {
      kind: 'application',
      feature: 'compute',
      purpose: 'job-completion-analysis',
      deliveryKey: 'compute_done:session-1:job-1,job-2',
      jobIds: ['job-1', 'job-2']
    }
    expect(session?.messages[0]?.attribution).toEqual(attribution)
    expect(isComputeJobCompletionAttribution(session?.messages[0]?.attribution)).toBe(true)
    expect(
      session &&
        materializeSessionConversationGraph(session).conversationGraph?.messages[0]?.attribution
    ).toEqual(attribution)
  })

  it('preserves a non-authoritative Compute completion presentation through Session JSON', () => {
    const session = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      messages: [
        {
          id: 'compute-presentation-message-1',
          role: 'user',
          content: 'Analyze completed remote jobs.',
          status: 'complete',
          eventIds: [],
          presentation: { kind: 'compute-job-completion' },
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })

    expect(session?.messages[0]?.presentation).toEqual({ kind: 'compute-job-completion' })
    expect(
      session &&
        materializeSessionConversationGraph(session).conversationGraph?.messages[0]?.presentation
    ).toEqual({ kind: 'compute-job-completion' })
  })

  it.each([
    [
      'an extended marker',
      'user',
      'Analyze completed remote jobs.',
      { kind: 'compute-job-completion', rendererClaim: true }
    ],
    [
      'a marker from an Agent message',
      'agent',
      'Analysis result.',
      { kind: 'compute-job-completion' }
    ]
  ] as const)('drops %s', (_label, role, content, presentation) => {
    const session = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      messages: [
        {
          id: 'compute-presentation-message-1',
          role,
          content,
          status: 'complete',
          eventIds: [],
          presentation,
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })

    expect(session?.messages[0]?.presentation).toBeUndefined()
  })

  it('rejects malformed or extended Compute delivery attribution', () => {
    expect(
      sanitizeMessageAttribution({
        kind: 'application',
        feature: 'compute',
        purpose: 'job-completion-analysis',
        deliveryKey: 'compute_done:session-1:job-1',
        jobIds: []
      })
    ).toBeUndefined()
    expect(
      sanitizeMessageAttribution({
        kind: 'application',
        feature: 'compute',
        purpose: 'job-completion-analysis',
        deliveryKey: 'compute_done:session-1:job-1',
        jobIds: ['job-1'],
        rendererClaim: true
      })
    ).toBeUndefined()
  })

  it('drops malformed or extended attribution without dropping the Message', () => {
    expect(
      sanitizeMessageAttribution({
        kind: 'application',
        feature: 'reviewer',
        purpose: 'correction',
        causeReviewId: 'review-1',
        rendererClaim: true
      })
    ).toBeUndefined()
    const session = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      messages: [
        {
          id: 'legacy-message',
          role: 'user',
          content: '[Auditor] remains visible as human text',
          status: 'complete',
          eventIds: [],
          attribution: { kind: 'unknown', feature: 'reviewer' },
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })

    expect(session?.messages[0]).toMatchObject({
      id: 'legacy-message',
      role: 'user',
      content: '[Auditor] remains visible as human text'
    })
    expect(session?.messages[0]).not.toHaveProperty('attribution')
  })
})

describe('message agent target persistence', () => {
  const agentTarget = {
    frameworkId: 'claude-code',
    backendId: 'claude-anthropic',
    providerId: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'high'
  }

  const normalizeWithMessages = (messages: unknown[]): ReturnType<typeof normalizeSessionFile> =>
    normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      messages
    })

  it('preserves a valid send-target snapshot on a user Message', () => {
    const session = normalizeWithMessages([
      {
        id: 'message-1',
        role: 'user',
        content: 'Run the analysis',
        status: 'complete',
        eventIds: [],
        agentTarget,
        createdAt: 2,
        updatedAt: 2
      }
    ])

    expect(session?.messages[0]?.agentTarget).toEqual(agentTarget)
    expect(
      session &&
        materializeSessionConversationGraph(session).conversationGraph?.messages[0]?.agentTarget
    ).toEqual(agentTarget)
  })

  it('omits optional backend and model fields when absent', () => {
    const session = normalizeWithMessages([
      {
        id: 'message-1',
        role: 'user',
        content: 'Run the analysis',
        status: 'complete',
        eventIds: [],
        agentTarget: {
          frameworkId: 'opencode',
          providerId: 'provider-a',
          reasoningEffort: 'default'
        },
        createdAt: 2,
        updatedAt: 2
      }
    ])

    expect(session?.messages[0]?.agentTarget).toEqual({
      frameworkId: 'opencode',
      providerId: 'provider-a',
      reasoningEffort: 'default'
    })
  })

  it.each([
    ['an unknown framework', { ...agentTarget, frameworkId: 'not-a-framework' }],
    ['a missing provider', { ...agentTarget, providerId: '' }],
    ['an unknown effort', { ...agentTarget, reasoningEffort: 'extreme' }],
    ['a non-object value', 'claude-code']
  ])('drops %s without dropping the Message', (_label, candidate) => {
    const session = normalizeWithMessages([
      {
        id: 'message-1',
        role: 'user',
        content: 'Run the analysis',
        status: 'complete',
        eventIds: [],
        agentTarget: candidate,
        createdAt: 2,
        updatedAt: 2
      }
    ])

    expect(session?.messages[0]).toMatchObject({ id: 'message-1', role: 'user' })
    expect(session?.messages[0]).not.toHaveProperty('agentTarget')
  })

  it('drops snapshots from agent Messages', () => {
    const session = normalizeWithMessages([
      {
        id: 'message-1',
        role: 'agent',
        content: 'Done',
        status: 'complete',
        eventIds: [],
        agentTarget,
        createdAt: 2,
        updatedAt: 2
      }
    ])

    expect(session?.messages[0]).not.toHaveProperty('agentTarget')
  })
})

describe('message part persistence', () => {
  it('preserves valid structured annotations on annotation-only user Messages', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: '',
          annotations: [
            {
              id: 'annotation-1',
              kind: 'text',
              target: 'agent',
              quote: '  Preserve this evidence.  ',
              note: '  Explain it.  ',
              source: {
                kind: 'agent-message',
                sessionId: 'session-1',
                messageId: 'agent-message-1'
              }
            },
            {
              id: 'pdf-1',
              kind: 'pdf',
              target: 'agent',
              source: {
                kind: 'upload-version',
                projectId: 'project-1',
                sessionId: 'session-1',
                versionId: 'version-1',
                name: 'paper.pdf',
                path: 'upload-version:project-1/session-1/version-1',
                checksum: 'a'.repeat(64)
              },
              selector: {
                kind: 'text',
                pageNumber: 2,
                exact: 'PDF evidence',
                position: { start: 5, end: 17 },
                quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
                extractorVersion: 'pdfjs-5.4.624'
              }
            },
            { kind: 'unknown' }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    expect(restored?.messages[0].annotations).toEqual([
      {
        id: 'annotation-1',
        kind: 'text',
        target: 'agent',
        quote: 'Preserve this evidence.',
        note: 'Explain it.',
        source: {
          kind: 'agent-message',
          sessionId: 'session-1',
          messageId: 'agent-message-1'
        }
      },
      {
        id: 'pdf-1',
        kind: 'pdf',
        target: 'agent',
        source: {
          kind: 'upload-version',
          projectId: 'project-1',
          sessionId: 'session-1',
          versionId: 'version-1',
          name: 'paper.pdf',
          path: 'upload-version:project-1/session-1/version-1',
          checksum: 'a'.repeat(64)
        },
        selector: {
          kind: 'text',
          pageNumber: 2,
          exact: 'PDF evidence',
          position: { start: 5, end: 17 },
          quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
          extractorVersion: 'pdfjs-5.4.624'
        }
      }
    ])
  })

  it('collects at most five unique Session references with their first title snapshot', () => {
    expect(
      collectSessionReferences([
        { type: 'session', sessionId: 'session-1', title: 'Original title' },
        { type: 'session', sessionId: 'session-1', title: 'Renamed title' },
        ...Array.from({ length: 5 }, (_, index) => ({
          type: 'session' as const,
          sessionId: `session-${index + 2}`,
          title: `Session ${index + 2}`
        }))
      ])
    ).toEqual([
      { type: 'session', sessionId: 'session-1', title: 'Original title' },
      { type: 'session', sessionId: 'session-2', title: 'Session 2' },
      { type: 'session', sessionId: 'session-3', title: 'Session 3' },
      { type: 'session', sessionId: 'session-4', title: 'Session 4' },
      { type: 'session', sessionId: 'session-5', title: 'Session 5' }
    ])
  })

  it('preserves only Session identity and the reference-time title snapshot', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: '#Earlier result',
          parts: [
            {
              type: 'session',
              sessionId: 'session-2',
              title: 'Earlier result',
              projectId: 'must-not-persist',
              frameId: 'must-not-persist'
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    expect(restored?.messages[0].parts).toEqual([
      { type: 'session', sessionId: 'session-2', title: 'Earlier result' }
    ])
  })

  it('round-trips managed file and Version identity for an upload mention', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: '@shared.csv',
          parts: [
            {
              type: 'artifact',
              id: 'upload:shared-csv',
              sourceFileId: 'shared-csv',
              versionId: 'shared-csv-v2',
              name: 'shared.csv',
              source: 'upload',
              path: 'upload-version:project-a/source-session/shared-csv-v2'
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    expect(restored?.messages[0].parts).toEqual([
      {
        type: 'artifact',
        id: 'upload:shared-csv',
        sourceFileId: 'shared-csv',
        versionId: 'shared-csv-v2',
        name: 'shared.csv',
        source: 'upload',
        path: 'upload-version:project-a/source-session/shared-csv-v2'
      }
    ])
  })

  it('preserves a linked-folder reference as root id plus relative path', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: '@study.csv',
          parts: [
            {
              type: 'artifact',
              id: 'linked-1',
              name: 'study.csv',
              source: 'linked-folder',
              rootId: 'root-1',
              relativePath: 'data/study.csv',
              path: '/must/not/be/persisted'
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    expect(restored?.messages[0].parts).toEqual([
      {
        type: 'artifact',
        id: 'linked-1',
        name: 'study.csv',
        source: 'linked-folder',
        rootId: 'root-1',
        relativePath: 'data/study.csv'
      }
    ])
  })
})

describe('interrupted turn intent persistence', () => {
  it('preserves only closed application-owned intents on user messages', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      messages: [
        {
          id: 'user-plan',
          role: 'user',
          content: 'Plan the analysis',
          turnIntent: 'plan-first',
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'user-save-as-skill',
          role: 'user',
          content: 'Save as skill',
          turnIntent: 'save-as-skill',
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'user-unknown',
          role: 'user',
          content: 'Do not restore arbitrary intent',
          turnIntent: 'hidden-injection',
          createdAt: 3,
          updatedAt: 3
        },
        {
          id: 'agent-plan',
          role: 'agent',
          content: 'No user intent here',
          turnIntent: 'plan-first',
          createdAt: 4,
          updatedAt: 4
        }
      ]
    })

    expect(restored?.messages).toEqual([
      expect.objectContaining({ id: 'user-plan', turnIntent: 'plan-first' }),
      expect.objectContaining({
        id: 'user-save-as-skill',
        turnIntent: 'save-as-skill'
      }),
      expect.not.objectContaining({ turnIntent: expect.anything() }),
      expect.not.objectContaining({ turnIntent: expect.anything() })
    ])
  })
})

describe('side chat relay persistence', () => {
  it('preserves only the closed side-chat advisory marker on user messages', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      messages: [
        {
          id: 'side-chat-advisory',
          role: 'user',
          content: 'Please use a black line.',
          relayedFrom: { kind: 'side-chat', direction: 'to-main' },
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'unknown-relay',
          role: 'user',
          content: 'Do not restore arbitrary routing metadata.',
          relayedFrom: { kind: 'external-agent', direction: 'to-main' },
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'agent-relay',
          role: 'agent',
          content: 'No relay marker on agent messages.',
          relayedFrom: { kind: 'side-chat', direction: 'to-main' },
          createdAt: 3,
          updatedAt: 3
        }
      ]
    })

    expect(restored?.messages).toEqual([
      expect.objectContaining({
        id: 'side-chat-advisory',
        relayedFrom: { kind: 'side-chat', direction: 'to-main' }
      }),
      expect.not.objectContaining({ relayedFrom: expect.anything() }),
      expect.not.objectContaining({ relayedFrom: expect.anything() })
    ])
  })
})

describe('message terminal time persistence', () => {
  it('backfills stable terminal timestamps for legacy agent messages', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      messages: [
        {
          id: 'complete-message',
          role: 'agent',
          content: 'Done',
          status: 'complete',
          eventIds: [],
          createdAt: 10,
          updatedAt: 20
        },
        {
          id: 'failed-message',
          role: 'agent',
          content: 'Partial',
          status: 'error',
          eventIds: [],
          createdAt: 30,
          updatedAt: 40
        }
      ]
    })

    expect(restored?.messages).toEqual([
      expect.objectContaining({ id: 'complete-message', completedAt: 20 }),
      expect.objectContaining({ id: 'failed-message', failedAt: 40 })
    ])
  })

  it('preserves response linkage and explicit terminal timestamps when updatedAt changes later', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      messages: [
        {
          id: 'prompt-message',
          role: 'user',
          content: 'Run the analysis',
          status: 'complete',
          eventIds: [],
          createdAt: 10,
          updatedAt: 10
        },
        {
          id: 'complete-message',
          role: 'agent',
          content: 'Done',
          status: 'complete',
          eventIds: [],
          responseToMessageId: 'prompt-message',
          createdAt: 11,
          completedAt: 20,
          updatedAt: 99
        },
        {
          id: 'failed-message',
          role: 'agent',
          content: 'Partial result',
          status: 'error',
          eventIds: [],
          responseToMessageId: 'prompt-message',
          createdAt: 12,
          failedAt: 30,
          updatedAt: 100
        }
      ]
    })

    expect(restored?.messages[1]).toMatchObject({
      responseToMessageId: 'prompt-message',
      completedAt: 20,
      updatedAt: 99
    })
    expect(restored?.messages[2]).toMatchObject({
      responseToMessageId: 'prompt-message',
      failedAt: 30,
      updatedAt: 100
    })
  })
})

describe('upload message persistence', () => {
  it('keeps immutable Version identity while removing absolute legacy paths', () => {
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Uploads',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Analyze this',
          uploads: [
            {
              id: 'upload-1',
              versionId: 'upload-version-1',
              versionNumber: 1,
              createdAt: '2026-07-27T12:00:00.000Z',
              sessionId: 'session-1',
              name: 'input.csv',
              originalName: 'input.csv',
              path: '/Users/private/input.csv',
              size: 12,
              checksum: 'a'.repeat(64)
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })

    expect(restored?.messages[0].uploads).toEqual([
      {
        id: 'upload-1',
        versionId: 'upload-version-1',
        versionNumber: 1,
        createdAt: '2026-07-27T12:00:00.000Z',
        sessionId: 'session-1',
        name: 'input.csv',
        originalName: 'input.csv',
        size: 12,
        sha256: 'a'.repeat(64)
      }
    ])
    expect(JSON.stringify(restored)).not.toContain('/Users/private/input.csv')
  })
})

describe('message image persistence', () => {
  it('keeps only bounded raster images with recomputed byte metadata', () => {
    const images = sanitizeMessageImages([
      { id: 'image-1', mimeType: 'image/png', data: 'AQID', byteLength: 999 },
      { id: 'image-svg', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' },
      { id: 'image-bad', mimeType: 'image/jpeg', data: 'not base64!' }
    ])

    expect(images).toEqual([{ id: 'image-1', mimeType: 'image/png', data: 'AQID', byteLength: 3 }])
  })

  it('caps the number of persisted images in one message', () => {
    const images = sanitizeMessageImages(
      Array.from({ length: 6 }, (_, index) => ({
        id: `image-${index}`,
        mimeType: 'image/webp',
        data: 'AQID'
      }))
    )

    expect(images).toHaveLength(4)
    expect(images?.map((image) => image.id)).toEqual(['image-0', 'image-1', 'image-2', 'image-3'])
  })

  it('round-trips valid message images and drops invalid persisted data', () => {
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Images',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'message-1',
          role: 'agent',
          content: '',
          status: 'complete',
          eventIds: ['event-1'],
          images: [
            { id: 'event-1', mimeType: 'image/png', data: 'AQID' },
            { id: 'event-2', mimeType: 'text/html', data: 'AQID' }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })

    expect(restored?.messages[0].images).toEqual([
      { id: 'event-1', mimeType: 'image/png', data: 'AQID', byteLength: 3 }
    ])
  })

  it('applies the aggregate session image budget while restoring legacy files', () => {
    const data = 'A'.repeat(4 * 1024 * 1024)
    const bytesPerImage = (data.length * 3) / 4
    const messageCount = MAX_ACP_SESSION_IMAGE_BYTES / bytesPerImage + 1
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Images',
      cwd: '/workspace',
      status: 'idle',
      messages: Array.from({ length: messageCount }, (_, index) => ({
        id: `message-${index}`,
        role: 'agent',
        content: '',
        images: [{ id: `image-${index}`, mimeType: 'image/png', data }],
        createdAt: index,
        updatedAt: index
      })),
      createdAt: 1,
      updatedAt: 1
    })

    const restoredImages = restored?.messages.flatMap((message) => message.images ?? []) ?? []
    expect(restoredImages).toHaveLength(MAX_ACP_SESSION_IMAGE_BYTES / bytesPerImage)
    expect(restoredImages.reduce((total, image) => total + image.byteLength, 0)).toBe(
      MAX_ACP_SESSION_IMAGE_BYTES
    )
  })

  it('counts persisted PDF region Evidence against the aggregate session image budget', () => {
    const data = 'A'.repeat(4 * 1024 * 1024)
    const bytesPerImage = (data.length * 3) / 4
    const messageCount = MAX_ACP_SESSION_IMAGE_BYTES / bytesPerImage
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'PDF Evidence',
      cwd: '/workspace',
      status: 'idle',
      messages: Array.from({ length: messageCount }, (_, index) => ({
        id: `message-${index}`,
        role: index === 0 ? 'user' : 'agent',
        content: '',
        images: [{ id: `image-${index}`, mimeType: 'image/png', data }],
        ...(index === 0
          ? {
              annotations: [
                {
                  id: 'pdf-region-1',
                  kind: 'pdf',
                  target: 'agent',
                  source: {
                    kind: 'upload-version',
                    projectId: 'project-a',
                    sessionId: 'session-1',
                    versionId: 'version-1',
                    name: 'paper.pdf',
                    path: 'upload-version:project-a/session-1/version-1',
                    checksum: 'a'.repeat(64)
                  },
                  selector: {
                    kind: 'region',
                    pageNumber: 1,
                    rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
                    pageRotation: 0,
                    image: { mimeType: 'image/png', data }
                  }
                }
              ]
            }
          : {}),
        createdAt: index,
        updatedAt: index
      })),
      createdAt: 1,
      updatedAt: 1
    })

    const restoredImages = restored?.messages.flatMap((message) => message.images ?? []) ?? []
    const region = restored?.messages[0]?.annotations?.[0]
    expect(region?.kind === 'pdf' && region.selector.kind === 'region').toBe(true)
    expect(restoredImages).toHaveLength(messageCount - 1)
    expect(
      restoredImages.reduce((total, image) => total + image.byteLength, 0) + bytesPerImage
    ).toBe(MAX_ACP_SESSION_IMAGE_BYTES)
  })

  it('sanitizes images that exist only on an inactive conversation branch before writing', () => {
    const activeMessage = {
      id: 'active-message',
      role: 'user' as const,
      content: 'Active prompt',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [activeMessage],
      createdAt: 1,
      updatedAt: 2
    })
    const inactiveBranchId = 'message-branch-inactive'
    const inactiveMessageId = 'inactive-message'
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-a',
      title: 'Images',
      cwd: '/workspace',
      status: 'idle',
      messages: [activeMessage],
      conversationGraph: {
        ...graph,
        branches: [
          ...graph.branches,
          {
            id: inactiveBranchId,
            agentFrameId: graph.rootFrameId,
            parentBranchId: graph.branches[0].id,
            headMessageId: inactiveMessageId,
            createdAt: 2,
            updatedAt: 2
          }
        ],
        messages: [
          ...graph.messages,
          {
            id: inactiveMessageId,
            role: 'agent',
            content: 'Inactive reply',
            status: 'complete',
            eventIds: [],
            images: Array.from({ length: 6 }, (_, index) => ({
              id: `inactive-image-${index}`,
              mimeType: 'image/png' as const,
              data: 'AQID',
              byteLength: 999
            })),
            agentFrameId: graph.rootFrameId,
            introducedOnBranchId: inactiveBranchId,
            createdAt: 2,
            updatedAt: 2
          }
        ]
      },
      createdAt: 1,
      updatedAt: 2
    }

    const persisted = createSessionFile(session).session
    const inactiveImages = persisted.conversationGraph?.messages.find(
      (message) => message.id === inactiveMessageId
    )?.images

    expect(inactiveImages).toHaveLength(4)
    expect(inactiveImages?.every((image) => image.byteLength === 3)).toBe(true)
  })
})

describe('conversation Activity fork persistence', () => {
  it('round-trips the Activity cutoff that separates revised answer Branches', () => {
    const messages = [
      {
        id: 'user-1',
        role: 'user' as const,
        content: 'Build something',
        status: 'complete' as const,
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'agent-1',
        role: 'agent' as const,
        content: 'Choose one',
        status: 'complete' as const,
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      },
      {
        id: 'agent-2',
        role: 'agent' as const,
        content: 'Old answer path',
        status: 'complete' as const,
        eventIds: [],
        createdAt: 4,
        updatedAt: 4
      }
    ]
    const graph = synchronizeActiveConversationActivities(
      createLinearConversationGraph({
        sessionId: 'session-1',
        messages,
        createdAt: 1,
        updatedAt: 4
      }),
      [
        {
          id: 'before-choice',
          kind: 'tool',
          title: 'Inspect context',
          status: 'completed',
          sortIndex: 0,
          eventIds: [],
          promptMessageId: 'user-1',
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'choice-1',
          kind: 'tool',
          title: 'Choose one',
          status: 'completed',
          sortIndex: 1,
          eventIds: [],
          promptMessageId: 'user-1',
          createdAt: 3,
          updatedAt: 3
        }
      ],
      []
    )
    const forked = forkConversationAfterActivity(graph, 'agent-1', 'choice-1', 'revised-choice', 5)
    const restored = normalizeSessionFile(
      createSessionFile({
        id: 'session-1',
        projectId: 'project-a',
        title: 'Choice revision',
        cwd: '/workspace',
        status: 'idle',
        messages: messages.slice(0, 2),
        activities: [
          {
            id: 'before-choice',
            kind: 'tool',
            title: 'Inspect context',
            status: 'completed',
            sortIndex: 0,
            eventIds: [],
            createdAt: 2,
            updatedAt: 5
          }
        ],
        conversationGraph: forked,
        createdAt: 1,
        updatedAt: 5
      })
    )

    expect(
      restored?.conversationGraph?.branches.find((branch) => branch.id === 'revised-choice')
        ?.forkActivityId
    ).toBe('choice-1')
    expect(
      restored?.conversationGraph?.activities.find((item) => item.id === 'before-choice')
    ).toMatchObject({
      messageBranchId: graph.branches[0].id
    })
    expect(
      resolveActiveConversationActivities(restored!.conversationGraph!).activities.map(
        (item) => item.id
      )
    ).toEqual(['before-choice'])
    expect(
      resolveActiveConversationActivities(
        activateConversationBranch(restored!.conversationGraph!, graph.branches[0].id)
      ).activities.map((item) => item.id)
    ).toEqual(['before-choice', 'choice-1'])
  })
})

describe('turn token usage persistence', () => {
  it('round-trips valid totals and drops invalid usage fields', () => {
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Usage',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'message-valid',
          role: 'agent',
          content: 'Done',
          status: 'complete',
          eventIds: [],
          turnUsage: {
            inputTokens: 12_345,
            cacheTokens: 678,
            cachedReadTokens: 500,
            cachedWriteTokens: 178,
            outputTokens: 90,
            turnCount: 3
          },
          modelCallUsage: [
            {
              id: 'call-1',
              index: 0,
              sourceInvocationId: 'provider-call-1',
              inputTokens: 4_000,
              cacheTokens: 200,
              outputTokens: 30,
              contextUsedTokens: 4_200,
              contextWindowSize: 128_000
            },
            {
              id: 'call-2',
              index: 1,
              inputTokens: 4_100,
              cacheTokens: 220,
              outputTokens: 30,
              contextUsedTokens: 4_320,
              contextWindowSize: 128_000
            },
            {
              id: 'call-3',
              index: 2,
              inputTokens: 4_245,
              cacheTokens: 258,
              outputTokens: 30,
              contextUsedTokens: 4_503,
              contextWindowSize: 128_000
            }
          ],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'message-invalid-call-window',
          role: 'agent',
          content: 'Done with malformed call metadata',
          status: 'complete',
          eventIds: [],
          turnUsage: { inputTokens: 4, cacheTokens: 2, outputTokens: 3, turnCount: 1 },
          modelCallUsage: [
            {
              id: 'call-invalid-window',
              index: 0,
              inputTokens: 4,
              cacheTokens: 2,
              outputTokens: 3,
              contextUsedTokens: 6,
              contextWindowSize: 0
            }
          ],
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'message-duplicate-call-id-a',
          role: 'agent',
          content: 'Done with duplicate call identity',
          status: 'complete',
          eventIds: [],
          turnUsage: { inputTokens: 1, cacheTokens: 0, outputTokens: 1, turnCount: 1 },
          modelCallUsage: [
            {
              id: 'duplicate-call',
              index: 0,
              inputTokens: 1,
              cacheTokens: 0,
              outputTokens: 1
            }
          ],
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'message-duplicate-call-id-b',
          role: 'agent',
          content: 'Also done with duplicate call identity',
          status: 'complete',
          eventIds: [],
          turnUsage: { inputTokens: 2, cacheTokens: 0, outputTokens: 1, turnCount: 1 },
          modelCallUsage: [
            {
              id: 'duplicate-call',
              index: 0,
              inputTokens: 2,
              cacheTokens: 0,
              outputTokens: 1
            }
          ],
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'message-invalid',
          role: 'agent',
          content: 'Also done',
          status: 'complete',
          eventIds: [],
          turnUsage: { inputTokens: -1, cacheTokens: 2, outputTokens: 3 },
          turnUsageUnavailable: true,
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'message-user',
          role: 'user',
          content: 'Prompt',
          status: 'complete',
          eventIds: [],
          turnUsageUnavailable: true,
          createdAt: 3,
          updatedAt: 3
        }
      ],
      createdAt: 1,
      updatedAt: 2
    })

    expect(restored?.messages[0].turnUsage).toEqual({
      inputTokens: 12_345,
      cacheTokens: 678,
      cachedReadTokens: 500,
      cachedWriteTokens: 178,
      outputTokens: 90,
      turnCount: 3
    })
    expect(restored?.messages[0].modelCallUsage).toEqual([
      {
        id: 'call-1',
        index: 0,
        sourceInvocationId: 'provider-call-1',
        inputTokens: 4_000,
        cacheTokens: 200,
        outputTokens: 30,
        contextUsedTokens: 4_200,
        contextWindowSize: 128_000
      },
      {
        id: 'call-2',
        index: 1,
        inputTokens: 4_100,
        cacheTokens: 220,
        outputTokens: 30,
        contextUsedTokens: 4_320,
        contextWindowSize: 128_000
      },
      {
        id: 'call-3',
        index: 2,
        inputTokens: 4_245,
        cacheTokens: 258,
        outputTokens: 30,
        contextUsedTokens: 4_503,
        contextWindowSize: 128_000
      }
    ])
    expect(restored?.messages[1].modelCallUsage).toEqual([
      {
        id: 'call-invalid-window',
        index: 0,
        inputTokens: 4,
        cacheTokens: 2,
        outputTokens: 3,
        contextUsedTokens: 6
      }
    ])
    expect(restored?.messages[2].modelCallUsage).toBeUndefined()
    expect(restored?.messages[3].modelCallUsage).toBeUndefined()
    expect(restored?.messages[4].turnUsage).toBeUndefined()
    expect(restored?.messages[4].turnUsageUnavailable).toBe(true)
    expect(restored?.messages[5].turnUsageUnavailable).toBeUndefined()
  })
})

describe('context usage persistence', () => {
  it('round-trips a valid snapshot and drops malformed usage', () => {
    const contextUsage = {
      used: 29_500,
      agentUsed: 29_500,
      size: 168_000,
      breakdown: {
        source: 'estimated',
        tokenizer: 'o200k_base',
        model: 'gpt-5.6-sol',
        estimatedTokens: 29_405,
        difference: 95,
        status: 'reconciled',
        categories: [
          { key: 'system', tokens: 7_200, estimated: true },
          { key: 'other', tokens: 95, estimated: false }
        ]
      }
    }
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      contextUsage
    })
    const malformed = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      contextUsage: { used: -1, size: 168_000 }
    })
    const unsafeBreakdown = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      contextUsage: {
        used: 100,
        breakdown: {
          source: 'estimated',
          estimatedTokens: 100,
          difference: 0,
          status: 'reconciled',
          categories: [{ key: 'unknown', tokens: 100, estimated: true }]
        }
      }
    })

    expect(restored?.contextUsage).toEqual(contextUsage)
    expect(malformed?.contextUsage).toBeUndefined()
    expect(unsafeBreakdown?.contextUsage).toEqual({ used: 100 })
  })

  it('round-trips valid context-window samples and drops malformed or agent-owned samples', () => {
    const stopReasons = [
      'end_turn',
      'max_tokens',
      'max_turn_requests',
      'refusal',
      'cancelled'
    ] as const
    const validSamples = [
      ...stopReasons.map((stopReason, index) => ({
        id: `event-${index}`,
        timestamp: index + 1,
        termination: { kind: 'stop', stopReason },
        runtimeSegmentId: 'segment-1',
        contextWindow: { used: 30_000 + index, size: 168_000 },
        modelStepUsage: {
          inputTokens: 20_000,
          cacheTokens: 10_000,
          cachedReadTokens: 10_000,
          cachedWriteTokens: 0,
          outputTokens: 100
        },
        source: 'provider-response'
      })),
      {
        id: 'event-error',
        timestamp: 10,
        termination: { kind: 'error' },
        contextWindow: { used: 31_000 },
        source: 'local-estimate'
      }
    ]
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'Prompt',
          status: 'complete',
          eventIds: [],
          contextWindowSamples: [
            ...validSamples,
            {
              id: 'bad-reason',
              timestamp: 11,
              termination: { kind: 'stop', stopReason: 'unknown' },
              contextWindow: { used: 1 },
              source: 'provider-response'
            },
            {
              id: 'bad-context',
              timestamp: 12,
              termination: { kind: 'error' },
              contextWindow: { used: -1 },
              source: 'local-estimate'
            }
          ],
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'agent-1',
          role: 'agent',
          content: 'Done',
          status: 'complete',
          eventIds: [],
          contextWindowSamples: validSamples,
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })

    expect(restored?.messages[0].contextWindowSamples).toEqual(validSamples)
    expect(restored?.messages[1].contextWindowSamples).toBeUndefined()
  })
})

describe('sanitizeToolActivity', () => {
  it('keeps a valid structured-input projection on the tool activity', () => {
    const activity = sanitizeToolActivity({
      id: 'tool-ask-1',
      status: 'in_progress',
      elicitation: {
        message: 'Which approach should I use?',
        fields: [
          {
            id: 'question_0',
            label: 'Approach',
            kind: 'single-select',
            required: true,
            options: [
              {
                value: 'minimal',
                label: 'Minimal change',
                description: 'Reuse the existing activity model.'
              }
            ]
          }
        ],
        state: 'answered',
        answers: [{ fieldId: 'question_0', value: 'minimal' }],
        respondedAt: 42
      }
    })

    expect(activity?.elicitation).toEqual({
      message: 'Which approach should I use?',
      fields: [
        {
          id: 'question_0',
          label: 'Approach',
          kind: 'single-select',
          required: true,
          options: [
            {
              value: 'minimal',
              label: 'Minimal change',
              description: 'Reuse the existing activity model.'
            }
          ]
        }
      ],
      state: 'answered',
      answers: [{ fieldId: 'question_0', value: 'minimal' }],
      respondedAt: 42
    })
  })

  it.each([
    [
      'duplicate field identities',
      [
        { id: 'answer', label: 'First answer', kind: 'text' },
        { id: 'answer', label: 'Second answer', kind: 'text' }
      ]
    ],
    [
      'contradictory field constraints',
      [{ id: 'answer', label: 'Answer', kind: 'text', minLength: 2, maxLength: 1 }]
    ]
  ])('drops a persisted elicitation with %s', (_label, fields) => {
    const activity = sanitizeToolActivity({
      id: 'tool-invalid-elicitation',
      status: 'in_progress',
      elicitation: {
        message: 'Provide an answer',
        fields,
        state: 'pending'
      }
    })

    expect(activity).not.toHaveProperty('elicitation')
  })

  it('rejects an oversized option list before reading its entries', () => {
    const options = new Array(MAX_ELICITATION_OPTIONS_PER_FIELD + 1)
    Object.defineProperty(options, 0, {
      get: () => {
        throw new Error('oversized options should be rejected before entry access')
      }
    })

    expect(() =>
      sanitizeToolActivity({
        id: 'tool-oversized-options',
        status: 'in_progress',
        elicitation: {
          message: 'Choose an option',
          fields: [{ id: 'answer', label: 'Answer', kind: 'single-select', options }],
          state: 'pending'
        }
      })
    ).not.toThrow()
  })

  it('removes an invalid persisted default without discarding the elicitation', () => {
    const activity = sanitizeToolActivity({
      id: 'tool-invalid-default',
      status: 'in_progress',
      elicitation: {
        message: 'Choose the number of attempts',
        fields: [
          {
            id: 'attempts',
            label: 'Attempts',
            kind: 'integer',
            minimum: 1,
            maximum: 3,
            defaultValue: '2'
          }
        ],
        state: 'pending'
      }
    })

    expect(activity?.elicitation?.fields).toEqual([
      {
        id: 'attempts',
        label: 'Attempts',
        kind: 'integer',
        minimum: 1,
        maximum: 3
      }
    ])
  })

  it('preserves the authorization origin in durable elicitation provenance', () => {
    const activity = sanitizeToolActivity({
      id: 'tool-durable-choice',
      status: 'in_progress',
      elicitation: {
        message: 'Choose an approach',
        fields: [
          {
            id: 'approach',
            label: 'Approach',
            kind: 'single-select',
            options: [
              { value: 'minimal', label: 'Minimal' },
              { value: 'expanded', label: 'Expanded' }
            ]
          }
        ],
        state: 'pending',
        durable: {
          kind: 'agent-user-choice',
          requestId: 'choice-1',
          promptMessageId: 'synthetic-continuation',
          provenanceContext: {
            promptMessageId: 'synthetic-continuation',
            originMessageId: 'authorizing-user-message'
          }
        }
      }
    })

    expect(activity?.elicitation?.durable?.provenanceContext).toEqual({
      promptMessageId: 'synthetic-continuation',
      originMessageId: 'authorizing-user-message'
    })
  })

  it('keeps identity fields and known text/diff content', () => {
    const activity = sanitizeToolActivity({
      id: 'tool-1',
      kind: 'tool',
      title: 'Edit app.ts',
      activityGroupId: 'group-1',
      promptMessageId: 'prompt-1',
      executionInvocationId: 'execution-1',
      status: 'completed',
      sortIndex: 3,
      eventIds: ['event-1'],
      providerToolName: 'Edit',
      toolKind: 'edit',
      toolLocations: [{ path: '/repo/app.ts', line: 12 }],
      toolContent: [
        { type: 'content', content: { type: 'text', text: 'ok' } },
        { type: 'diff', path: '/repo/app.ts', oldText: 'a', newText: 'b' },
        { type: 'terminal', terminalId: 'term-1' }
      ],
      createdAt: 5,
      updatedAt: 6
    })

    expect(activity).toMatchObject({
      id: 'tool-1',
      kind: 'tool',
      title: 'Edit app.ts',
      activityGroupId: 'group-1',
      promptMessageId: 'prompt-1',
      executionInvocationId: 'execution-1',
      status: 'completed',
      providerToolName: 'Edit',
      toolKind: 'edit',
      toolLocations: [{ path: '/repo/app.ts', line: 12 }]
    })
    // Terminal references carry no payload and are dropped; text/diff entries survive.
    expect(activity?.toolContent).toEqual([
      { type: 'content', content: { type: 'text', text: 'ok' } },
      { type: 'diff', path: '/repo/app.ts', oldText: 'a', newText: 'b' }
    ])
  })

  it('keeps legacy activities without an execution invocation identity', () => {
    const activity = sanitizeToolActivity({ id: 'legacy-tool', status: 'in_progress' })

    expect(activity).not.toHaveProperty('executionInvocationId')
  })

  it('keeps only known tool dispositions', () => {
    expect(
      sanitizeToolActivity({
        id: 'tool-closed',
        status: 'in_progress',
        toolDisposition: 'permission-closed'
      })
    ).toMatchObject({ toolDisposition: 'permission-closed' })
    expect(
      sanitizeToolActivity({
        id: 'tool-declined',
        status: 'completed',
        toolDisposition: 'declined'
      })?.toolDisposition
    ).toBe('declined')
    expect(
      sanitizeToolActivity({
        id: 'tool-unknown',
        status: 'completed',
        toolDisposition: 'cancelled'
      })?.toolDisposition
    ).toBeUndefined()
  })

  it('truncates oversized terminal output', () => {
    const activity = sanitizeToolActivity({
      id: 'tool-1',
      status: 'completed',
      terminalOutput: 'x'.repeat(40_000)
    })

    expect(activity?.terminalOutput?.length).toBeLessThan(40_000)
    expect(activity?.terminalOutput?.endsWith('…')).toBe(true)
  })

  it('drops oversized raw payloads while keeping small ones', () => {
    const big = sanitizeToolActivity({
      id: 'tool-1',
      status: 'completed',
      rawInput: { filename: 'big.png', content: 'A'.repeat(50_000) }
    })
    const small = sanitizeToolActivity({
      id: 'tool-2',
      status: 'completed',
      rawInput: { command: 'ls -la' }
    })

    expect(big?.rawInput).toBeUndefined()
    expect(small?.rawInput).toEqual({ command: 'ls -la' })
  })

  it('rejects entries without an id', () => {
    expect(sanitizeToolActivity({ status: 'completed' })).toBeUndefined()
  })
})

describe('sanitizeActivityGroup', () => {
  it('keeps a valid group declaration bounded and structured', () => {
    expect(
      sanitizeActivityGroup({
        id: 'group-1',
        title: 'Inspect the implementation.',
        sortIndex: 4,
        activityIds: ['tool-1'],
        createdAt: 5,
        updatedAt: 6
      })
    ).toEqual({
      id: 'group-1',
      title: 'Inspect the implementation',
      sortIndex: 4,
      activityIds: ['tool-1'],
      createdAt: 5,
      updatedAt: 6
    })
  })
})

describe('normalizeSessionFile with activities', () => {
  it('normalizes delegated caller identity as one value and fails closed on legacy half-state', () => {
    const baseMessage = {
      id: 'child-prompt',
      role: 'user',
      content: 'work',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const paired = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      messages: [
        {
          ...baseMessage,
          delegatedCallerMessageId: 'root-prompt',
          delegatedToolInvocationId: 'delegate-call'
        }
      ]
    })
    const half = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      messages: [{ ...baseMessage, delegatedCallerMessageId: 'root-prompt' }]
    })

    expect(paired?.messages[0]).toMatchObject({
      delegatedCallerSource: {
        rootMessageId: 'root-prompt',
        toolInvocationId: 'delegate-call'
      }
    })
    expect(paired?.messages[0]).not.toHaveProperty('delegatedCallerMessageId')
    expect(half?.messages[0]).not.toHaveProperty('delegatedCallerSource')
  })

  it('quarantines the removed pendingMessages prototype instead of migrating it', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      runtimeContext: {
        version: 1,
        revision: 1,
        delegatedWork: {
          records: [
            {
              agentFrameId: 'child-frame',
              attempts: [
                {
                  id: 'attempt-1',
                  status: 'running',
                  resolvedAgent: { kind: 'main' },
                  runtimeSegmentIds: [],
                  startedAt: 1
                }
              ],
              pendingMessages: [
                {
                  id: 'pending-1',
                  sourceFrameId: 'root-frame',
                  targetFrameId: 'child-frame',
                  text: 'continue',
                  kind: 'info',
                  callerMessageId: 'root-prompt',
                  createdAt: 2
                }
              ]
            }
          ]
        }
      }
    })

    expect(restored?.runtimeContext?.delegatedWork).toMatchObject({
      records: [],
      recordsQuarantine: [
        expect.objectContaining({
          agentFrameId: 'child-frame',
          pendingMessages: [expect.objectContaining({ id: 'pending-1' })]
        })
      ]
    })
  })

  it('quarantines corrupt delegated-work records without discarding sibling runtime owners', () => {
    const corruptRecords = [{ agentFrameId: 'child-frame', attempts: 'not-an-array' }]
    const restored = normalizeSessionFile(
      {
        ...createSessionWithActivity(undefined),
        runtimeContext: {
          version: 1,
          revision: 7,
          plan: createRuntimePlan(),
          delegatedWork: {
            records: corruptRecords,
            messageCommands: []
          },
          permission: {
            state: 'pending',
            request: {
              requestId: 'permission-1',
              sessionId: 'session-1',
              toolCallId: 'tool-1',
              title: 'Run tests',
              options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }]
            },
            originatingPromptMessageId: 'message-1',
            fingerprint: 'a'.repeat(64),
            createdAt: 2
          },
          sideChat: {
            version: 1,
            id: 'side-chat-1',
            lifecycle: 'open',
            frameworkId: 'codex',
            historyPreamble: 'Preserved context',
            entries: [],
            createdAt: 2,
            updatedAt: 2
          }
        }
      },
      { preserveRuntimeState: true }
    )

    expect(restored?.runtimeContext).toMatchObject({
      revision: 7,
      plan: createRuntimePlan(),
      permission: { originatingPromptMessageId: 'message-1' },
      sideChat: { id: 'side-chat-1' },
      delegatedWork: {
        records: [],
        recordsQuarantine: corruptRecords,
        messageCommands: []
      }
    })
  })

  it('retains existing records quarantine when a later records generation is also corrupt', () => {
    const previous = [{ agentFrameId: 'previous-child', attempts: 'previous-corruption' }]
    const current = [{ agentFrameId: 'current-child', attempts: 'current-corruption' }]

    const sanitized = sanitizeSessionRuntimeContext({
      version: 1,
      revision: 8,
      delegatedWork: {
        records: current,
        recordsQuarantine: previous,
        messageCommands: []
      }
    })

    expect(sanitized?.delegatedWork).toEqual({
      records: [],
      recordsQuarantine: {
        previous,
        current
      },
      messageCommands: []
    })
  })

  it('reads legacy terminal Attempts without inventing an initiating Turn association', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      runtimeContext: {
        version: 1,
        revision: 1,
        delegatedWork: {
          records: [
            {
              agentFrameId: 'legacy-child',
              attempts: [
                {
                  id: 'legacy-attempt',
                  status: 'cancelled',
                  resolvedAgent: { kind: 'main' },
                  runtimeSegmentIds: [],
                  startedAt: 1,
                  endedAt: 2,
                  cancellationReason: 'runtime_interrupted'
                }
              ]
            }
          ]
        }
      }
    })

    expect(restored?.runtimeContext?.delegatedWork?.records[0].attempts[0]).toEqual({
      id: 'legacy-attempt',
      status: 'cancelled',
      resolvedAgent: { kind: 'main' },
      runtimeSegmentIds: [],
      startedAt: 1,
      endedAt: 2,
      cancellationReason: 'runtime_interrupted'
    })
  })

  it('round-trips a resolved Subagent model snapshot without backfilling legacy Attempts', () => {
    const baseAttempt = {
      id: 'attempt-with-model',
      status: 'cancelled',
      resolvedAgent: { kind: 'main' },
      runtimeSegmentIds: [],
      startedAt: 1,
      endedAt: 2,
      cancellationReason: 'runtime_interrupted'
    }
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      runtimeContext: {
        version: 1,
        revision: 1,
        delegatedWork: {
          records: [
            {
              agentFrameId: 'child-frame',
              attempts: [
                {
                  ...baseAttempt,
                  executionModel: {
                    frameworkId: 'opencode',
                    providerId: 'provider-b',
                    backendId: 'opencode:provider-b',
                    modelRoute: 'opencode-openai',
                    model: 'model-b',
                    reasoningEffort: 'high'
                  }
                }
              ]
            }
          ]
        }
      }
    })

    expect(restored?.runtimeContext?.delegatedWork?.records[0].attempts[0].executionModel).toEqual({
      frameworkId: 'opencode',
      providerId: 'provider-b',
      backendId: 'opencode:provider-b',
      modelRoute: 'opencode-openai',
      model: 'model-b',
      reasoningEffort: 'high'
    })
  })

  it('preserves a valid archive timestamp across a file round-trip', () => {
    const persisted = createSessionFile({
      ...(createSessionWithActivity(undefined) as PersistedChatSession),
      activities: undefined,
      archivedAt: 1_723_000_000_000
    })

    expect(normalizeSessionFile(persisted)?.archivedAt).toBe(1_723_000_000_000)
  })

  it('round-trips a main-owned runtime context and preserves plan approval waiting across restart', () => {
    const persisted = createSessionFile({
      ...(createSessionWithActivity(undefined) as PersistedChatSession),
      activities: undefined,
      status: 'waiting-plan-approval',
      runtimeContext: {
        version: 1,
        revision: 3,
        plan: createRuntimePlan()
      }
    })

    const restored = normalizeSessionFile(persisted)

    expect(restored).toMatchObject({
      status: 'waiting-plan-approval',
      runtimeContext: {
        version: 1,
        revision: 3,
        plan: createRuntimePlan()
      }
    })
    expect(restored?.error).toBeUndefined()
  })

  it('preserves the Plan materialization boundary across restart', () => {
    const plan = { ...createRuntimePlan(), materializedAt: 42 }
    const restored = normalizeSessionFile(
      createSessionFile({
        ...(createSessionWithActivity(undefined) as PersistedChatSession),
        activities: undefined,
        status: 'waiting-plan-approval',
        runtimeContext: { version: 1, revision: 3, plan }
      })
    )

    expect(restored?.runtimeContext?.plan?.materializedAt).toBe(42)
  })

  it('restores a queued approved-Plan continuation command for durable dispatch', () => {
    const persisted = createSessionFile({
      ...(createSessionWithActivity(undefined) as PersistedChatSession),
      activities: undefined,
      status: 'idle',
      runtimeContext: {
        version: 1,
        revision: 4,
        plan: {
          ...createRuntimePlan(),
          approval: 'approved',
          continuation: {
            commandId: 'continuation-1',
            kind: 'approved-plan',
            state: 'queued',
            originatingPromptMessageId: 'prompt-plan-1',
            createdAt: 42
          }
        }
      }
    })

    expect(normalizeSessionFile(persisted)?.runtimeContext?.plan?.continuation).toEqual({
      commandId: 'continuation-1',
      kind: 'approved-plan',
      state: 'queued',
      originatingPromptMessageId: 'prompt-plan-1',
      createdAt: 42
    })
  })

  it('preserves neutral Plan review feedback across restart while approval remains pending', () => {
    const plan = {
      ...createRuntimePlan(),
      reviewFeedbackMessageId: 'feedback-message-1'
    }
    const restored = normalizeSessionFile(
      createSessionFile({
        ...(createSessionWithActivity(undefined) as PersistedChatSession),
        activities: undefined,
        status: 'waiting-plan-approval',
        runtimeContext: { version: 1, revision: 4, plan }
      })
    )

    expect(restored?.runtimeContext?.plan).toEqual(plan)
  })

  it.each([
    { approval: 'approved', kind: 'approved-plan' },
    { approval: 'rejected', kind: 'rejected-plan' }
  ] as const)(
    'restores a queued $kind continuation paired to its $approval Plan',
    ({ approval, kind }) => {
      const continuation = {
        commandId: `continuation-${approval}`,
        kind,
        state: 'queued' as const,
        originatingPromptMessageId: 'prompt-plan-1',
        createdAt: 42
      }
      const restored = normalizeSessionFile(
        createSessionFile({
          ...(createSessionWithActivity(undefined) as PersistedChatSession),
          activities: undefined,
          runtimeContext: {
            version: 1,
            revision: 4,
            plan: { ...createRuntimePlan(), approval, continuation }
          }
        })
      )

      expect(restored?.runtimeContext?.plan?.continuation).toEqual(continuation)
    }
  )

  it('restores a queued review-feedback continuation paired to its pending Plan marker', () => {
    const continuation = {
      commandId: 'continuation-feedback',
      kind: 'review-feedback' as const,
      state: 'queued' as const,
      originatingPromptMessageId: 'feedback-message-1',
      createdAt: 42
    }
    const restored = normalizeSessionFile(
      createSessionFile({
        ...(createSessionWithActivity(undefined) as PersistedChatSession),
        activities: undefined,
        runtimeContext: {
          version: 1,
          revision: 4,
          plan: {
            ...createRuntimePlan(),
            reviewFeedbackMessageId: 'feedback-message-1',
            continuation
          }
        }
      })
    )

    expect(restored?.runtimeContext?.plan?.continuation).toEqual(continuation)
  })

  it.each([
    {
      name: 'review marker on an approved Plan',
      plan: {
        ...createRuntimePlan(),
        approval: 'approved' as const,
        reviewFeedbackMessageId: 'feedback-message-1'
      },
      missing: 'reviewFeedbackMessageId'
    },
    {
      name: 'review continuation whose origin differs from its marker',
      plan: {
        ...createRuntimePlan(),
        reviewFeedbackMessageId: 'feedback-message-1',
        continuation: {
          commandId: 'continuation-feedback',
          kind: 'review-feedback' as const,
          state: 'queued' as const,
          originatingPromptMessageId: 'different-message',
          createdAt: 42
        }
      },
      missing: 'continuation'
    },
    {
      name: 'rejected continuation whose origin differs from the Plan origin',
      plan: {
        ...createRuntimePlan(),
        approval: 'rejected' as const,
        continuation: {
          commandId: 'continuation-rejected',
          kind: 'rejected-plan' as const,
          state: 'queued' as const,
          originatingPromptMessageId: 'different-message',
          createdAt: 42
        }
      },
      missing: 'continuation'
    }
  ])('drops an invalid $name without losing the Plan', ({ plan, missing }) => {
    const restored = normalizeSessionFile(
      createSessionFile({
        ...(createSessionWithActivity(undefined) as PersistedChatSession),
        activities: undefined,
        runtimeContext: { version: 1, revision: 4, plan }
      })
    )

    expect(restored?.runtimeContext?.plan).toBeDefined()
    expect(restored?.runtimeContext?.plan).not.toHaveProperty(missing)
  })

  it('preserves a continuing approved-Plan command as a fail-closed dispatch tombstone', () => {
    const plan = {
      ...createRuntimePlan(),
      approval: 'approved' as const,
      continuation: {
        commandId: 'continuation-1',
        kind: 'approved-plan' as const,
        state: 'continuing' as const,
        originatingPromptMessageId: 'prompt-plan-1',
        createdAt: 42
      }
    }
    const persisted = createSessionFile({
      ...(createSessionWithActivity(undefined) as PersistedChatSession),
      activities: undefined,
      runtimeContext: { version: 1, revision: 5, plan }
    })

    expect(normalizeSessionFile(persisted)?.runtimeContext?.plan?.continuation).toEqual(
      plan.continuation
    )
  })

  it('restores an interrupted approved-Plan command without making it dispatchable', () => {
    const plan = {
      ...createRuntimePlan(),
      approval: 'approved' as const,
      continuation: {
        commandId: 'continuation-1',
        kind: 'approved-plan' as const,
        state: 'interrupted' as const,
        originatingPromptMessageId: 'prompt-plan-1',
        createdAt: 42
      }
    }
    const persisted = createSessionFile({
      ...(createSessionWithActivity(undefined) as PersistedChatSession),
      activities: undefined,
      runtimeContext: { version: 1, revision: 6, plan }
    })

    expect(normalizeSessionFile(persisted)?.runtimeContext?.plan?.continuation).toEqual(
      plan.continuation
    )
  })

  it('drops a malformed continuation command without losing the approved Plan', () => {
    const restored = normalizeSessionFile(
      createSessionFile({
        ...(createSessionWithActivity(undefined) as PersistedChatSession),
        activities: undefined,
        runtimeContext: {
          version: 1,
          revision: 5,
          plan: {
            ...createRuntimePlan(),
            approval: 'approved',
            continuation: {
              commandId: 'continuation-1',
              kind: 'approved-plan',
              state: 'unknown' as never,
              originatingPromptMessageId: 'prompt-plan-1',
              createdAt: 42
            }
          }
        }
      })
    )

    expect(restored?.runtimeContext?.plan).toMatchObject({ approval: 'approved' })
    expect(restored?.runtimeContext?.plan).not.toHaveProperty('continuation')
  })

  it('normalizes legacy permission authority to pending and accepts only known lifecycle states', () => {
    const permission = {
      request: {
        requestId: 'permission-1',
        sessionId: 'session-1',
        toolCallId: 'tool-1',
        title: 'Run npm test',
        options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }]
      },
      originatingPromptMessageId: 'prompt-1',
      fingerprint: 'a'.repeat(64),
      createdAt: 1
    }
    const normalizePermission = (
      candidate: Record<string, unknown>
    ): SessionPermissionRuntimeContext | undefined =>
      normalizeSessionFile(
        {
          ...createSessionWithActivity(undefined),
          activities: undefined,
          runtimeContext: { version: 1, revision: 1, permission: candidate }
        },
        { preserveRuntimeState: true }
      )?.runtimeContext?.permission

    expect(normalizePermission(permission)?.state).toBe('pending')
    expect(normalizePermission({ ...permission, state: 'continuing' })?.state).toBe('continuing')
    expect(normalizePermission({ ...permission, state: 'unknown' })).toBeUndefined()
  })

  it('redacts credentials from persisted permission tool input', () => {
    const restored = normalizeSessionFile(
      {
        ...createSessionWithActivity(undefined),
        activities: undefined,
        runtimeContext: {
          version: 1,
          revision: 1,
          permission: {
            state: 'pending',
            request: {
              requestId: 'permission-secret',
              sessionId: 'session-1',
              toolCallId: 'tool-secret',
              title: 'curl https://example.test/data?token=test-permission-title-secret',
              options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
              rawInput: {
                query: 'safe input',
                connection: { password: 'test-password-secret' }
              }
            },
            originatingPromptMessageId: 'prompt-1',
            fingerprint: 'a'.repeat(64),
            createdAt: 1
          }
        }
      },
      { preserveRuntimeState: true }
    )
    const rawInput = restored?.runtimeContext?.permission?.request.rawInput

    expect(rawInput).toMatchObject({
      query: 'safe input',
      connection: { password: '[redacted]' }
    })
    expect(JSON.stringify(rawInput)).not.toContain('test-password-secret')
    expect(restored?.runtimeContext?.permission?.request.title).not.toContain(
      'test-permission-title-secret'
    )
  })

  it.each(['pending', 'in_progress'] as const)(
    'rearms a prompt-bound continuing MCP permission without failing its %s tool activity',
    (status) => {
      const restored = normalizeSessionFile(
        createContinuingPermissionFile([
          createOpenToolActivity('tool-1', { status }),
          createOpenToolActivity('unrelated-tool', {
            title: 'Read another file',
            sortIndex: 2,
            createdAt: 3,
            updatedAt: 3
          })
        ])
      )

      expect(restored).toMatchObject({
        status: 'waiting-permission',
        runtimeContext: {
          version: 1,
          revision: 4,
          permission: {
            state: 'pending',
            originatingPromptMessageId: 'prompt-1'
          }
        }
      })
      expect(restored?.activeRun).toBeUndefined()
      expect(restored?.resumeRecovery).toBeUndefined()
      expect(restored?.error).toBeUndefined()
      expect(restored?.messages[0]?.interrupted).toBeUndefined()
      expect(restored?.activities?.[0]?.status).toBe(status)
      expect(restored?.conversationGraph?.activities[0]?.status).toBe(status)
      expect(restored?.activities?.[1]?.status).toBe('failed')
      expect(restored?.conversationGraph?.activities[1]?.status).toBe('failed')
    }
  )

  it('fails a permission tool activity hidden by the active conversation branch', () => {
    const persisted = createContinuingPermissionFile([createOpenToolActivity()])
    expect(persisted.session.conversationGraph).toBeDefined()
    const conversationGraph = forkConversationAfterActivity(
      persisted.session.conversationGraph!,
      'prompt-1',
      'tool-1',
      'revised-branch',
      3
    )

    const restored = normalizeSessionFile({
      ...persisted,
      session: { ...persisted.session, conversationGraph }
    })

    expect(restored?.status).toBe('error')
    expect(restored?.runtimeContext?.permission).toBeUndefined()
    expect(restored?.activities?.[0]?.status).toBe('failed')
    expect(restored?.conversationGraph?.activities[0]?.status).toBe('failed')
  })

  it('releases a non-MCP permission instead of preserving its open tool activity', () => {
    const persisted = createContinuingPermissionFile([createOpenToolActivity()])
    persisted.session.runtimeContext!.permission!.request.isMcp = false

    const restored = normalizeSessionFile(persisted)

    expect(restored?.status).toBe('error')
    expect(restored?.runtimeContext?.permission).toBeUndefined()
    expect(restored?.activities?.[0]?.status).toBe('failed')
    expect(restored?.conversationGraph?.activities[0]?.status).toBe('failed')
  })

  it('releases a permission whose exact tool activity is missing', () => {
    const restored = normalizeSessionFile(
      createContinuingPermissionFile([createOpenToolActivity('unrelated-tool')])
    )

    expect(restored?.status).toBe('error')
    expect(restored?.runtimeContext?.permission).toBeUndefined()
    expect(restored?.activities?.[0]?.status).toBe('failed')
    expect(restored?.conversationGraph?.activities[0]?.status).toBe('failed')
  })

  it('releases a permission whose exact tool activity is already terminal', () => {
    const restored = normalizeSessionFile(
      createContinuingPermissionFile([
        createOpenToolActivity('tool-1', { status: 'completed', updatedAt: 3 })
      ])
    )

    expect(restored?.status).toBe('error')
    expect(restored?.runtimeContext?.permission).toBeUndefined()
    expect(restored?.activities?.[0]?.status).toBe('completed')
    expect(restored?.conversationGraph?.activities[0]?.status).toBe('completed')
  })

  it('releases pending permission authority attached to a non-waiting Session', () => {
    const persisted = createContinuingPermissionFile([createOpenToolActivity()])
    const permission = persisted.session.runtimeContext!.permission!
    const restored = normalizeSessionFile({
      ...persisted,
      session: {
        ...persisted.session,
        runtimeContext: {
          ...persisted.session.runtimeContext!,
          permission: { ...permission, state: 'pending' }
        }
      }
    })

    expect(restored?.status).toBe('error')
    expect(restored?.runtimeContext?.permission).toBeUndefined()
    expect(restored?.activities?.[0]?.status).toBe('failed')
    expect(restored?.conversationGraph?.activities[0]?.status).toBe('failed')
  })

  it('releases continuing permission authority attached to a non-running Session', () => {
    const persisted = createContinuingPermissionFile([createOpenToolActivity()])
    const restored = normalizeSessionFile({
      ...persisted,
      session: { ...persisted.session, status: 'idle' }
    })

    expect(restored?.status).toBe('error')
    expect(restored?.runtimeContext?.permission).toBeUndefined()
    expect(restored?.activities?.[0]?.status).toBe('failed')
    expect(restored?.conversationGraph?.activities[0]?.status).toBe('failed')
  })

  it('releases permission authority with duplicated flat tool call correlation', () => {
    const persisted = createContinuingPermissionFile([createOpenToolActivity()])
    const activity = persisted.session.activities![0]
    const restored = normalizeSessionFile({
      ...persisted,
      session: {
        ...persisted.session,
        activities: [activity, { ...activity, title: 'Duplicate tool projection' }]
      }
    })

    expect(restored?.status).toBe('error')
    expect(restored?.runtimeContext?.permission).toBeUndefined()
    expect(restored?.activities?.map((candidate) => candidate.status)).toEqual(['failed', 'failed'])
    expect(restored?.conversationGraph?.activities[0]?.status).toBe('failed')
  })

  it('fails a mismatched flat permission activity instead of trusting its tool call id', () => {
    const persisted = createContinuingPermissionFile([createOpenToolActivity()])
    const restored = normalizeSessionFile({
      ...persisted,
      session: {
        ...persisted.session,
        activities: persisted.session.activities?.map((activity) => ({
          ...activity,
          promptMessageId: 'stale-prompt'
        }))
      }
    })

    expect(restored?.status).toBe('error')
    expect(restored?.runtimeContext?.permission).toBeUndefined()
    expect(restored?.activities?.[0]?.status).toBe('failed')
    expect(restored?.conversationGraph?.activities[0]?.status).toBe('failed')
  })

  it('releases an invalid continuing permission before generic restart recovery', () => {
    const restored = normalizeSessionFile(
      createContinuingPermissionFile([createOpenToolActivity()], 'missing-prompt')
    )

    expect(restored?.status).toBe('error')
    expect(restored?.runtimeContext?.permission).toBeUndefined()
    expect(restored?.activities?.[0]?.status).toBe('failed')
    expect(restored?.conversationGraph?.activities[0]?.status).toBe('failed')
    expect(restored?.resumeRecovery).toEqual({
      kind: 'resume-required',
      cause: 'app-restart',
      promptMessageId: 'prompt-1'
    })
    expect(restored).toMatchObject({
      status: 'error',
      error: 'Session was interrupted before the app closed.'
    })
    expect(restored?.activeRun).toBeUndefined()
  })

  it('hoists legacy Side chat relays without changing the Session envelope version', () => {
    const persisted = createSessionFile({
      ...(createSessionWithActivity(undefined) as PersistedChatSession),
      activities: undefined,
      runtimeContext: {
        version: 1,
        revision: 7,
        sideChat: {
          version: 1,
          id: 'side-chat-123',
          lifecycle: 'interrupted',
          frameworkId: 'codex',
          providerId: 'provider-1',
          backendId: 'codex-responses',
          providerSessionId: 'provider-session-1',
          providerContinuityToken: 'bridge-token-1',
          model: 'gpt-5.6-sol',
          historyPreamble: 'Main context',
          entries: [
            { id: 'user-1', kind: 'message', role: 'user', text: 'Question' },
            { id: 'assistant-1', kind: 'message', role: 'assistant', text: 'Answer' },
            { id: 'tool-1', kind: 'tool', title: 'send_message', status: 'completed' }
          ],
          pendingRelays: [{ id: 'side-chat-message-1', text: 'Tell Main', createdAt: 10 }],
          createdAt: 1,
          updatedAt: 10
        } as unknown as PersistedSideChat
      }
    })

    expect(persisted.version).toBe(SESSION_FILE_VERSION)
    expect(normalizeSessionFile(persisted)?.runtimeContext).toEqual({
      version: 1,
      revision: 7,
      sideChat: {
        version: 1,
        id: 'side-chat-123',
        lifecycle: 'interrupted',
        frameworkId: 'codex',
        providerId: 'provider-1',
        backendId: 'codex-responses',
        providerSessionId: 'provider-session-1',
        providerContinuityToken: 'bridge-token-1',
        model: 'gpt-5.6-sol',
        historyPreamble: 'Main context',
        entries: [
          { id: 'user-1', kind: 'message', role: 'user', text: 'Question' },
          { id: 'assistant-1', kind: 'message', role: 'assistant', text: 'Answer' },
          { id: 'tool-1', kind: 'tool', title: 'send_message', status: 'completed' }
        ],
        createdAt: 1,
        updatedAt: 10
      },
      sideChatRelays: [
        {
          id: 'side-chat-message-1',
          sideChatId: 'side-chat-123',
          text: 'Tell Main',
          createdAt: 10
        }
      ]
    })
  })

  it('round-trips parent-owned Side chat relays without an open Side chat', () => {
    const persisted = createSessionFile({
      ...(createSessionWithActivity(undefined) as PersistedChatSession),
      activities: undefined,
      runtimeContext: {
        version: 1,
        revision: 8,
        sideChatRelays: [
          {
            id: 'side-chat-message-closed',
            sideChatId: 'side-chat-closed',
            text: 'Still deliver this',
            createdAt: 11
          }
        ]
      }
    })

    expect(normalizeSessionFile(persisted)?.runtimeContext).toEqual({
      version: 1,
      revision: 8,
      sideChatRelays: [
        {
          id: 'side-chat-message-closed',
          sideChatId: 'side-chat-closed',
          text: 'Still deliver this',
          createdAt: 11
        }
      ]
    })
  })

  it('drops a malformed Side chat while retaining valid Plan authority', () => {
    const plan = createRuntimePlan()
    const restored = normalizeSessionFile({
      ...(createSessionWithActivity(undefined) as PersistedChatSession),
      activities: undefined,
      runtimeContext: {
        version: 1,
        revision: 8,
        plan,
        sideChat: {
          version: 1,
          id: '../unsafe-profile',
          lifecycle: 'open',
          frameworkId: 'codex',
          historyPreamble: '',
          entries: [],
          pendingRelays: [],
          createdAt: 1,
          updatedAt: 1
        }
      }
    })

    expect(restored?.runtimeContext).toEqual({ version: 1, revision: 8, plan })
  })

  it('round-trips special Plan step titles without changing object prototypes', () => {
    const specialStatuses = JSON.parse(
      '{"toString":{"status":"completed","updatedAt":1},"constructor":{"status":"skipped","updatedAt":2},"__proto__":{"status":"blocked","updatedAt":3}}'
    ) as Record<string, unknown>
    const restored = normalizeSessionFile({
      ...(createSessionWithActivity(undefined) as PersistedChatSession),
      activities: undefined,
      runtimeContext: {
        version: 1,
        revision: 3,
        plan: { ...createRuntimePlan(), stepStatuses: specialStatuses }
      }
    })
    const statuses = restored?.runtimeContext?.plan?.stepStatuses

    expect(statuses).toBeDefined()
    expect(Object.getPrototypeOf(statuses)).toBe(Object.prototype)
    expect(Object.hasOwn(statuses!, '__proto__')).toBe(true)
    expect(statuses?.toString).toMatchObject({ status: 'completed' })
    expect(statuses?.constructor).toMatchObject({ status: 'skipped' })
    expect(statuses?.__proto__).toMatchObject({ status: 'blocked' })
  })

  it('does not restore the expired interaction identity for a pending Plan', () => {
    const restored = normalizeSessionFile({
      ...(createSessionWithActivity(undefined) as PersistedChatSession),
      activities: undefined,
      status: 'waiting-plan-approval',
      activeRun: { promptMessageId: 'expired-prompt', startedAt: 10 },
      runtimeContext: {
        version: 1,
        revision: 3,
        plan: createRuntimePlan()
      }
    })

    expect(restored?.status).toBe('waiting-plan-approval')
    expect(restored?.activeRun).toBeUndefined()
    expect(restored?.error).toBeUndefined()
  })

  it('restores an approved incomplete Plan passively instead of as a generic Session error', () => {
    const plan = { ...createRuntimePlan(), approval: 'approved' as const }
    const restored = normalizeSessionFile({
      ...(createSessionWithActivity(undefined) as PersistedChatSession),
      activities: undefined,
      status: 'running',
      activeRun: { promptMessageId: 'prompt-1', startedAt: 10 },
      runtimeContext: { version: 1, revision: 4, plan }
    })

    expect(restored).toMatchObject({
      status: 'idle',
      runtimeContext: { version: 1, revision: 4, plan }
    })
    expect(restored?.activeRun).toBeUndefined()
    expect(restored?.error).toBeUndefined()
  })

  it.each(['approved', 'rejected'] as const)(
    'does not restore a %s Plan as still waiting for approval',
    (approval) => {
      const restored = normalizeSessionFile({
        ...(createSessionWithActivity(undefined) as PersistedChatSession),
        activities: undefined,
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 4,
          plan: { ...createRuntimePlan(), approval }
        }
      })

      expect(restored?.status).toBe('idle')
      expect(restored?.activeRun).toBeUndefined()
    }
  )

  it('drops unknown or damaged runtime context without losing the conversation', () => {
    const unknown = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      runtimeContext: { version: 1, revision: 8, alienAuthority: { active: true } }
    })
    const damaged = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      title: 'Conversation survives',
      status: 'waiting-plan-approval',
      runtimeContext: { version: 1, revision: -1, plan: { approval: 'approved' } }
    })
    const malformedPlan = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      status: 'waiting-plan-approval',
      runtimeContext: { version: 1, revision: 2, plan: null }
    })

    expect(unknown).toMatchObject({ id: 'session-1', messages: [] })
    expect(unknown?.runtimeContext).toBeUndefined()
    expect(damaged).toMatchObject({
      title: 'Conversation survives',
      status: 'idle',
      messages: []
    })
    expect(damaged?.runtimeContext).toBeUndefined()
    expect(malformedPlan).toMatchObject({ status: 'idle', messages: [] })
    expect(malformedPlan?.runtimeContext).toBeUndefined()
  })

  it('restores a persisted session with its activities intact', () => {
    const activities = getRestoredActivities(
      createSessionWithActivity({
        id: 'activity-1',
        kind: 'tool',
        title: 'ls',
        status: 'completed',
        sortIndex: 1,
        eventIds: [],
        providerToolName: 'Bash',
        toolKind: 'execute',
        createdAt: 1,
        updatedAt: 1
      })
    )

    expect(activities).toEqual([
      expect.objectContaining({ id: 'activity-1', providerToolName: 'Bash', status: 'completed' })
    ])
  })

  it('restores open activities as failed', () => {
    const activities = getRestoredActivities(
      createSessionWithActivity({
        id: 'activity-1',
        kind: 'tool',
        title: 'downloading',
        status: 'in_progress',
        sortIndex: 1,
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      })
    )

    expect(activities?.[0]?.status).toBe('failed')
  })

  it.each([
    'mcp__open-science-notebook__notebook_execute',
    'open_science_notebook_repl_execute',
    'mcp.open-science-notebook.bash_execute',
    'open-science-notebook/notebook_execute'
  ])('restores an unowned Notebook activity as static code for %s', (providerToolName) => {
    const activities = getRestoredActivities(
      createSessionWithActivity({
        id: 'activity-1',
        kind: 'tool',
        title: providerToolName,
        providerToolName,
        executionInvocationId: 'stale-invocation',
        status: 'in_progress',
        sortIndex: 1,
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      })
    )

    expect(activities?.[0]).toMatchObject({
      status: 'in_progress',
      toolDisposition: 'permission-closed'
    })
    expect(activities?.[0]).not.toHaveProperty('executionInvocationId')
  })

  it('keeps terminal Notebook Run correlation for historical projection', () => {
    const activities = getRestoredActivities(
      createSessionWithActivity({
        id: 'activity-1',
        kind: 'tool',
        title: 'mcp__open-science-notebook__notebook_execute',
        providerToolName: 'mcp__open-science-notebook__notebook_execute',
        executionInvocationId: 'completed-invocation',
        status: 'completed',
        sortIndex: 1,
        eventIds: [],
        createdAt: 1,
        updatedAt: 2
      })
    )

    expect(activities?.[0]?.executionInvocationId).toBe('completed-invocation')
  })

  it('does not treat a lookalike Notebook server as app-owned static code', () => {
    const activities = getRestoredActivities(
      createSessionWithActivity({
        id: 'activity-1',
        kind: 'tool',
        title: 'mcp__open-science-notebook-staging__notebook_execute',
        providerToolName: 'mcp__open-science-notebook-staging__notebook_execute',
        status: 'in_progress',
        sortIndex: 1,
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      })
    )

    expect(activities?.[0]?.status).toBe('failed')
  })

  it('restores a durable pending agent choice as actionable', () => {
    const activities = getRestoredActivities(
      createSessionWithActivity({
        id: 'activity-1',
        kind: 'tool',
        title: 'Waiting for an answer',
        status: 'in_progress',
        sortIndex: 1,
        eventIds: [],
        elicitation: {
          message: 'Choose one',
          fields: [{ id: 'choice', label: 'Choice', kind: 'text' }],
          state: 'pending',
          durable: {
            kind: 'agent-user-choice',
            requestId: 'choice-1'
          },
          draftAnswers: [{ fieldId: 'choice', value: 'First step' }]
        },
        createdAt: 1,
        updatedAt: 1
      })
    )

    expect(activities?.[0]).toMatchObject({
      status: 'in_progress',
      elicitation: {
        state: 'pending',
        durable: { kind: 'agent-user-choice', requestId: 'choice-1' },
        draftAnswers: [{ fieldId: 'choice', value: 'First step' }]
      }
    })
  })

  it('restores waiting-for-user only with a durable pending question', () => {
    const durableQuestion = createSessionWithActivity({
      id: 'activity-1',
      kind: 'tool',
      title: 'Waiting for an answer',
      status: 'in_progress',
      sortIndex: 1,
      eventIds: [],
      elicitation: {
        message: 'Choose one',
        fields: [{ id: 'choice', label: 'Choice', kind: 'text' }],
        state: 'pending',
        durable: { kind: 'agent-user-choice', requestId: 'choice-1' }
      },
      createdAt: 1,
      updatedAt: 1
    })

    expect(
      normalizeSessionFile(
        createSessionFile({
          ...(durableQuestion as PersistedChatSession),
          status: 'waiting-for-user'
        })
      )?.status
    ).toBe('waiting-for-user')
    expect(
      normalizeSessionFile(
        createSessionFile({
          ...(createSessionWithActivity(undefined) as PersistedChatSession),
          activities: undefined,
          status: 'waiting-for-user'
        })
      )?.status
    ).toBe('idle')
  })

  it('still cancels a non-durable pending protocol elicitation on restore', () => {
    const activities = getRestoredActivities(
      createSessionWithActivity({
        id: 'activity-1',
        kind: 'tool',
        title: 'Waiting for an answer',
        status: 'in_progress',
        sortIndex: 1,
        eventIds: [],
        elicitation: {
          message: 'Choose one',
          fields: [{ id: 'choice', label: 'Choice', kind: 'text' }],
          state: 'pending'
        },
        createdAt: 1,
        updatedAt: 1
      })
    )

    expect(activities?.[0]).toMatchObject({
      status: 'failed',
      elicitation: { state: 'cancelled' }
    })
  })

  it('restores open conversation graph activities as failed', () => {
    const persisted = createSessionFile({
      ...(createSessionWithActivity({
        id: 'activity-1',
        kind: 'tool',
        title: 'downloading',
        status: 'in_progress',
        sortIndex: 1,
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }) as PersistedChatSession),
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Download it',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const restored = normalizeSessionFile(persisted)

    expect(restored?.conversationGraph?.activities[0]?.status).toBe('failed')
  })

  it('builds a legacy conversation graph from normalized interrupted messages', () => {
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Interrupted session',
      cwd: '/workspace',
      status: 'running',
      messages: [
        {
          id: 'message-1',
          role: 'agent',
          content: 'Partial response',
          status: 'streaming',
          createdAt: 1,
          updatedAt: 7
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })

    expect(restored?.messages[0]?.status).toBe('error')
    expect(restored?.messages[0]?.failedAt).toBe(7)
    expect(restored?.conversationGraph?.messages[0]?.status).toBe('error')
    expect(restored?.conversationGraph?.messages[0]?.failedAt).toBe(7)
  })

  it('restores an active user turn as one durable interrupted message', () => {
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Interrupted session',
      cwd: '/workspace',
      status: 'running',
      activeRun: { promptMessageId: 'prompt-1', startedAt: 5 },
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'Continue the analysis',
          status: 'complete',
          eventIds: [],
          createdAt: 5,
          updatedAt: 5
        }
      ],
      createdAt: 1,
      updatedAt: 5
    })

    expect(restored?.messages).toEqual([
      expect.objectContaining({ id: 'prompt-1', interrupted: true })
    ])
    expect(restored?.conversationGraph?.messages).toEqual([
      expect.objectContaining({ id: 'prompt-1', interrupted: true })
    ])
    expect(restored?.resumeRecovery).toEqual({
      kind: 'resume-required',
      cause: 'app-restart',
      promptMessageId: 'prompt-1'
    })
  })

  it.each(['app-restart', 'cancelled', 'connection-lost'] as const)(
    'discards stale %s recovery after the prompt has a successful completed response',
    (cause) => {
      const restored = normalizeSessionFile({
        id: 'session-1',
        projectId: 'project-a',
        title: 'Completed session',
        cwd: '/workspace',
        status: 'idle',
        resumeRecovery: {
          kind: 'resume-required',
          cause,
          promptMessageId: 'prompt-1'
        },
        messages: [
          {
            id: 'prompt-1',
            role: 'user',
            content: 'Complete the task',
            status: 'complete',
            interrupted: true,
            eventIds: [],
            createdAt: 5,
            updatedAt: 5
          },
          {
            id: 'response-1',
            role: 'agent',
            content: 'Task completed.',
            status: 'complete',
            responseToMessageId: 'prompt-1',
            eventIds: [],
            createdAt: 6,
            completedAt: 7,
            updatedAt: 7
          }
        ],
        createdAt: 1,
        updatedAt: 7
      })

      expect(restored).toMatchObject({ status: 'idle' })
      expect(restored?.resumeRecovery).toBeUndefined()
      expect(restored?.error).toBeUndefined()
      expect(restored?.messages[0]).toMatchObject({ id: 'prompt-1', interrupted: true })
    }
  )

  it('discards stale recovery when the canonical active Branch has a completed response', () => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Complete the task',
        status: 'complete',
        interrupted: true,
        eventIds: [],
        createdAt: 5,
        updatedAt: 5
      },
      {
        id: 'response-1',
        role: 'agent',
        content: 'Task completed.',
        status: 'complete',
        responseToMessageId: 'prompt-1',
        eventIds: [],
        createdAt: 6,
        completedAt: 7,
        updatedAt: 7
      }
    ]
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Completed session',
      cwd: '/workspace',
      status: 'idle',
      resumeRecovery: {
        kind: 'resume-required',
        cause: 'app-restart',
        promptMessageId: 'prompt-1'
      },
      messages,
      conversationGraph: createLinearConversationGraph({
        sessionId: 'session-1',
        messages,
        createdAt: 1,
        updatedAt: 7
      }),
      createdAt: 1,
      updatedAt: 7
    })

    expect(restored?.resumeRecovery).toBeUndefined()
  })

  it('keeps recovery when a completed response exists only on an abandoned Branch', () => {
    const prompt: PersistedChatMessage = {
      id: 'prompt-1',
      role: 'user',
      content: 'Complete the task',
      status: 'complete',
      eventIds: [],
      createdAt: 5,
      updatedAt: 5
    }
    const abandonedResponse: PersistedChatMessage = {
      id: 'response-abandoned',
      role: 'agent',
      content: 'Abandoned response',
      status: 'complete',
      responseToMessageId: prompt.id,
      eventIds: [],
      createdAt: 6,
      completedAt: 7,
      updatedAt: 7
    }
    const graph = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [prompt],
      createdAt: 1,
      updatedAt: 7
    })
    const abandonedBranchId = 'message-branch-abandoned'
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Interrupted active branch',
      cwd: '/workspace',
      status: 'idle',
      resumeRecovery: {
        kind: 'resume-required',
        cause: 'app-restart',
        promptMessageId: prompt.id
      },
      messages: [prompt, abandonedResponse],
      conversationGraph: {
        ...graph,
        branches: [
          ...graph.branches,
          {
            id: abandonedBranchId,
            agentFrameId: graph.rootFrameId,
            parentBranchId: graph.branches[0].id,
            headMessageId: abandonedResponse.id,
            createdAt: 6,
            updatedAt: 7
          }
        ],
        messages: [
          ...graph.messages,
          {
            ...abandonedResponse,
            agentFrameId: graph.rootFrameId,
            introducedOnBranchId: abandonedBranchId
          }
        ]
      },
      createdAt: 1,
      updatedAt: 7
    })

    expect(restored?.messages.map(({ id }) => id)).toEqual([prompt.id])
    expect(restored?.resumeRecovery).toEqual({
      kind: 'resume-required',
      cause: 'app-restart',
      promptMessageId: prompt.id
    })
    expect(restored?.messages[0]).toMatchObject({ id: prompt.id, interrupted: true })
  })

  it('keeps app-restart recovery when the prompt only has a failed response', () => {
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Failed session',
      cwd: '/workspace',
      status: 'idle',
      resumeRecovery: {
        kind: 'resume-required',
        cause: 'app-restart',
        promptMessageId: 'prompt-1'
      },
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'Complete the task',
          status: 'complete',
          eventIds: [],
          createdAt: 5,
          updatedAt: 5
        },
        {
          id: 'response-0',
          role: 'agent',
          content: 'Earlier completed response',
          status: 'complete',
          responseToMessageId: 'prompt-1',
          eventIds: [],
          createdAt: 6,
          completedAt: 6,
          updatedAt: 6
        },
        {
          id: 'response-1',
          role: 'agent',
          content: 'Failed response',
          status: 'error',
          responseToMessageId: 'prompt-1',
          eventIds: [],
          createdAt: 7,
          failedAt: 7,
          updatedAt: 7
        }
      ],
      createdAt: 1,
      updatedAt: 7
    })

    expect(restored?.resumeRecovery).toEqual({
      kind: 'resume-required',
      cause: 'app-restart',
      promptMessageId: 'prompt-1'
    })
  })

  it('restores an active hidden Save as skill turn with its durable intent', () => {
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Interrupted session',
      cwd: '/workspace',
      status: 'running',
      activeRun: { promptMessageId: 'save-as-skill-control', startedAt: 5 },
      messages: [
        {
          id: 'save-as-skill-control',
          role: 'user',
          content: 'Save as skill',
          turnIntent: 'save-as-skill',
          status: 'complete',
          eventIds: [],
          createdAt: 5,
          updatedAt: 5
        }
      ],
      createdAt: 1,
      updatedAt: 5
    })

    expect(restored?.messages).toEqual([
      expect.objectContaining({
        id: 'save-as-skill-control',
        turnIntent: 'save-as-skill',
        interrupted: true
      })
    ])
    expect(restored?.resumeRecovery).toEqual({
      kind: 'resume-required',
      cause: 'app-restart',
      promptMessageId: 'save-as-skill-control'
    })
  })

  it('preserves a cancelled turn as resumable state', () => {
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Cancelled session',
      cwd: '/workspace',
      status: 'error',
      interrupted: true,
      resumeRecovery: {
        kind: 'resume-required',
        cause: 'cancelled',
        promptMessageId: 'prompt-1'
      },
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'Continue the analysis',
          status: 'complete',
          interrupted: true,
          eventIds: [],
          createdAt: 5,
          updatedAt: 5
        }
      ],
      createdAt: 1,
      updatedAt: 5
    })

    expect(restored?.resumeRecovery).toEqual({
      kind: 'resume-required',
      cause: 'cancelled',
      promptMessageId: 'prompt-1'
    })
  })

  it('restores explicit full and cutoff history replay scopes', () => {
    const base = {
      id: 'session-1',
      projectId: 'project-a',
      title: 'Replay state',
      cwd: '/workspace',
      status: 'idle',
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'Earlier prompt',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 2
    }

    expect(
      normalizeSessionFile({ ...base, pendingHistoryReplay: { kind: 'all' } })?.pendingHistoryReplay
    ).toEqual({ kind: 'all' })
    expect(
      normalizeSessionFile({
        ...base,
        pendingHistoryReplay: { kind: 'before-message', messageId: 'prompt-1' }
      })?.pendingHistoryReplay
    ).toEqual({ kind: 'before-message', messageId: 'prompt-1' })
    expect(
      normalizeSessionFile({
        ...base,
        pendingHistoryReplayBeforeMessageId: 'prompt-1'
      })?.pendingHistoryReplay
    ).toEqual({ kind: 'before-message', messageId: 'prompt-1' })
  })

  it('loads sessions that predate persisted activities', () => {
    const session = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-a',
      title: 'Legacy',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })

    expect(session?.activities).toBeUndefined()
    expect(session?.permissionProfile).toBe('ask')
  })

  it('preserves a valid files revision and ignores malformed revisions', () => {
    const current = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      filesRevision: 7
    })
    const malformed = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      filesRevision: -1
    })

    expect(current?.filesRevision).toBe(7)
    expect(malformed?.filesRevision).toBeUndefined()
  })

  it('round-trips agent, provider, backend, model identity, and Session configuration', () => {
    const session = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:codex-isolated',
      providerSessionId: '019fb8c8-6c66-7f22-9653-17b5b287dbbb',
      providerContinuityToken: 'bridge-generation-1',
      agentModel: 'gpt-5.6-sol',
      agentConfiguration: {
        providerId: 'codex-isolated',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high'
      }
    })

    expect(session?.agentFrameworkId).toBe('codex')
    expect(session?.agentBackendId).toBe('codex:codex-isolated')
    expect(session?.providerSessionId).toBe('019fb8c8-6c66-7f22-9653-17b5b287dbbb')
    expect(session?.providerContinuityToken).toBe('bridge-generation-1')
    expect(session?.agentModel).toBe('gpt-5.6-sol')
    expect(session?.agentConfiguration).toEqual({
      providerId: 'codex-isolated',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high'
    })
  })

  it('drops malformed Session agent configurations', () => {
    const session = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      agentConfiguration: {
        providerId: 'provider',
        model: 'model',
        reasoningEffort: 'extreme'
      }
    })

    expect(session?.agentConfiguration).toBeUndefined()
  })

  it('keeps known approval profiles and safely defaults unknown values', () => {
    const full = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      permissionProfile: 'full'
    })
    const unknown = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      permissionProfile: 'untrusted-profile'
    })

    expect(full?.permissionProfile).toBe('full')
    expect(unknown?.permissionProfile).toBe('ask')
  })

  it('round-trips the auto-review toggle and defaults older sessions to disabled', () => {
    const disabled = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      autoReviewEnabled: false
    })
    const enabled = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      autoReviewEnabled: true
    })
    // A session file written before the reviewer feature has no field at all.
    const legacy = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined
    })
    // A corrupt non-boolean value is treated as the safe default (disabled), not preserved.
    const corrupt = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      autoReviewEnabled: 'nope'
    })

    expect(disabled?.autoReviewEnabled).toBe(false)
    expect(enabled?.autoReviewEnabled).toBe(true)
    expect(legacy?.autoReviewEnabled).toBe(false)
    expect(corrupt?.autoReviewEnabled).toBe(false)
  })

  it('round-trips the Memory toggle and defaults older or malformed sessions to enabled', () => {
    const base = { ...createSessionWithActivity(undefined), activities: undefined }
    const disabled = normalizeSessionFile({ ...base, memoryEnabled: false })
    const enabled = normalizeSessionFile({ ...base, memoryEnabled: true })
    const legacy = normalizeSessionFile(base)
    const malformed = normalizeSessionFile({ ...base, memoryEnabled: 'nope' })

    expect(disabled?.memoryEnabled).toBe(false)
    expect(enabled?.memoryEnabled).toBe(true)
    expect(legacy?.memoryEnabled).toBe(true)
    expect(malformed?.memoryEnabled).toBe(true)
  })

  it('round-trips delegation policy and defaults historical or malformed values to allow', () => {
    const base = { ...createSessionWithActivity(undefined), activities: undefined }
    const denied = normalizeSessionFile({ ...base, delegationPolicy: 'deny' })
    const allowed = normalizeSessionFile({ ...base, delegationPolicy: 'allow' })
    const legacy = normalizeSessionFile({ ...base })
    const malformed = normalizeSessionFile({ ...base, delegationPolicy: 'sometimes' })

    expect(denied?.delegationPolicy).toBe('deny')
    expect(allowed?.delegationPolicy).toBe('allow')
    expect(legacy?.delegationPolicy).toBe('allow')
    expect(malformed?.delegationPolicy).toBe('allow')
  })

  it('round-trips enabledComputeHosts and filters out invalid values', () => {
    const base = { ...createSessionWithActivity(undefined), activities: undefined }

    // Valid ssh: prefixed provider ids survive the round-trip.
    const withHosts = normalizeSessionFile({
      ...base,
      enabledComputeHosts: ['ssh:cluster-1', 'ssh:gpu-box']
    })
    // Missing field (older sessions written before issue 06) → absent in output.
    const legacy = normalizeSessionFile({ ...base })
    // Non-ssh: strings are filtered out; only valid provider ids survive.
    const mixedValid = normalizeSessionFile({
      ...base,
      enabledComputeHosts: ['ssh:valid', 'not-ssh', '', 42]
    })
    // All invalid → field is absent (not an empty array).
    const allInvalid = normalizeSessionFile({
      ...base,
      enabledComputeHosts: ['no-prefix', 123]
    })

    expect(withHosts?.enabledComputeHosts).toEqual(['ssh:cluster-1', 'ssh:gpu-box'])
    expect(legacy?.enabledComputeHosts).toBeUndefined()
    expect(mixedValid?.enabledComputeHosts).toEqual(['ssh:valid'])
    expect(allInvalid?.enabledComputeHosts).toBeUndefined()
  })

  it('migrates legacy Compute Host access while preserving an explicit empty selection', () => {
    const base = { ...createSessionWithActivity(undefined), activities: undefined }

    const legacySelected = normalizeSessionFile({
      ...base,
      enabledComputeHosts: ['ssh:cluster-1', 'ssh:gpu-box']
    })
    const availableOnly = normalizeSessionFile({
      ...base,
      enabledComputeHosts: ['ssh:cluster-1'],
      selectedComputeHosts: []
    })
    const repairedSubset = normalizeSessionFile({
      ...base,
      enabledComputeHosts: ['ssh:cluster-1'],
      selectedComputeHosts: ['ssh:cluster-1', 'ssh:hidden', 'invalid']
    })

    expect(legacySelected?.selectedComputeHosts).toEqual(['ssh:cluster-1', 'ssh:gpu-box'])
    expect(availableOnly?.selectedComputeHosts).toEqual([])
    expect(repairedSubset?.selectedComputeHosts).toEqual(['ssh:cluster-1'])
  })

  it.each([
    ['invalid route', { direction: 'to_parent', disposition: 'continued' }],
    ['missing running target', { omitTargetAttemptId: true }],
    ['receipt shape', { receipt: { status: 'accepted', acceptedAt: 2, evidence: 'unknown' } }]
  ])(
    'quarantines only the reliable-message owner for an exhaustive %s violation',
    (_label, patch) => {
      const commandPatch: Record<string, unknown> = { ...patch }
      delete commandPatch.omitTargetAttemptId
      const command: Record<string, unknown> = {
        messageId: 'message-1',
        requestId: 'request-1',
        sourcePrincipal: 'root-frame',
        canonicalDigest: 'a'.repeat(64),
        sourceFrameId: 'root-frame',
        targetFrameId: 'child-frame',
        targetAttemptId: 'attempt-1',
        rootOriginMessageId: 'root-prompt',
        callerRootMessageId: 'root-prompt',
        rootBranchId: 'root-branch',
        rootBranchRevision: 'root-prompt',
        direction: 'to_child',
        disposition: 'message',
        text: 'evidence',
        kind: 'info',
        laneSequence: 1,
        queuedAt: 1,
        receipt: { status: 'queued' },
        ...commandPatch
      }
      if ('omitTargetAttemptId' in patch) delete command.targetAttemptId
      const sanitized = sanitizeSessionRuntimeContext({
        version: 1,
        revision: 7,
        plan: createRuntimePlan(),
        delegatedWork: { records: [], messageCommands: [command] }
      })

      expect(sanitized?.plan).toEqual(createRuntimePlan())
      expect(sanitized?.delegatedWork).toEqual({
        records: [],
        messageCommandsQuarantine: [command]
      })
    }
  )

  it('treats missing delegated questions as empty and quarantines only a corrupt question owner', () => {
    expect(
      sanitizeSessionRuntimeContext({
        version: 1,
        revision: 1,
        delegatedWork: { records: [] }
      })?.delegatedWork
    ).toEqual({ records: [] })

    const corrupt = [{ requestId: 'question-1', status: 'pending' }]
    const sanitized = sanitizeSessionRuntimeContext({
      version: 1,
      revision: 2,
      plan: createRuntimePlan(),
      delegatedWork: { records: [], questionRequests: corrupt }
    })
    expect(sanitized?.plan).toEqual(createRuntimePlan())
    expect(sanitized?.delegatedWork).toEqual({
      records: [],
      questionRequestsQuarantine: corrupt
    })

    const validQuestion = {
      requestId: 'question-valid',
      canonicalDigest: 'a'.repeat(64),
      sourceFrameId: 'child-1',
      sourceAttemptId: 'attempt-1',
      sourceRuntimeSegmentId: 'runtime-1',
      sourceMessageBranchId: 'child-branch',
      rootOriginMessageId: 'root-prompt',
      rootBranchId: 'root-branch',
      sourceName: 'Researcher',
      questions: [{ question: 'Scope?', options: [{ label: 'Narrow' }, { label: 'Broad' }] }],
      sequence: 1,
      askedAt: 1,
      status: 'pending',
      draftAnswers: [],
      draftQuestionIndex: 0
    }
    const isolated = sanitizeSessionRuntimeContext({
      version: 1,
      revision: 3,
      delegatedWork: {
        records: [],
        messageCommandsQuarantine: [{ unrelated: 'corruption' }],
        questionRequests: [validQuestion]
      }
    })
    expect(isolated?.delegatedWork).toEqual({
      records: [],
      messageCommandsQuarantine: [{ unrelated: 'corruption' }],
      questionRequests: [validQuestion]
    })
  })

  it('accepts equal or missing question sequences and narrowly recovers a wholly valid quarantine', () => {
    const question = (
      requestId: string,
      askedAt: number,
      sequence?: number
    ): Record<string, unknown> => ({
      requestId,
      canonicalDigest: requestId.charAt(requestId.length - 1).repeat(64),
      sourceFrameId: `child-${requestId}`,
      sourceAttemptId: `attempt-${requestId}`,
      sourceRuntimeSegmentId: `runtime-${requestId}`,
      sourceMessageBranchId: `branch-${requestId}`,
      rootOriginMessageId: 'root-prompt',
      rootBranchId: 'root-branch',
      sourceName: requestId,
      questions: [{ question: 'Scope?', options: [{ label: 'Narrow' }, { label: 'Broad' }] }],
      ...(sequence === undefined ? {} : { sequence }),
      askedAt,
      status: 'pending',
      draftAnswers: [],
      draftQuestionIndex: 0
    })
    const fallbackOrdered = [
      question('question-a', 2, 1),
      question('question-b', 3, 1),
      question('question-c', 1)
    ]

    expect(
      sanitizeSessionRuntimeContext({
        version: 1,
        revision: 4,
        delegatedWork: { records: [], questionRequests: fallbackOrdered }
      })?.delegatedWork
    ).toEqual({ records: [], questionRequests: fallbackOrdered })

    expect(
      sanitizeSessionRuntimeContext({
        version: 1,
        revision: 5,
        delegatedWork: { records: [], questionRequestsQuarantine: fallbackOrdered }
      })?.delegatedWork
    ).toEqual({ records: [], questionRequests: fallbackOrdered })

    const corrupt = [...fallbackOrdered, { requestId: 'question-invalid', status: 'pending' }]
    expect(
      sanitizeSessionRuntimeContext({
        version: 1,
        revision: 6,
        delegatedWork: { records: [], questionRequestsQuarantine: corrupt }
      })?.delegatedWork
    ).toEqual({ records: [], questionRequestsQuarantine: corrupt })
  })

  it('keeps a contradictory active and quarantined question owner fail-closed', () => {
    const quarantinedQuestion = {
      requestId: 'quarantined-question',
      canonicalDigest: 'a'.repeat(64),
      sourceFrameId: 'child-quarantined',
      sourceAttemptId: 'attempt-quarantined',
      sourceRuntimeSegmentId: 'runtime-quarantined',
      sourceMessageBranchId: 'branch-quarantined',
      rootOriginMessageId: 'root-prompt',
      rootBranchId: 'root-branch',
      sourceName: 'Quarantined child',
      questions: [{ question: 'Scope?', options: [{ label: 'Narrow' }, { label: 'Broad' }] }],
      sequence: 1,
      askedAt: 1,
      status: 'pending',
      draftAnswers: [],
      draftQuestionIndex: 0
    }
    const quarantine = [quarantinedQuestion]
    const active = [
      {
        ...quarantinedQuestion,
        requestId: 'active-question',
        canonicalDigest: 'b'.repeat(64),
        sourceFrameId: 'child-active',
        sourceName: 'Active child',
        sequence: 2
      }
    ]

    expect(
      sanitizeSessionRuntimeContext({
        version: 1,
        revision: 7,
        delegatedWork: {
          records: [],
          questionRequests: active,
          questionRequestsQuarantine: quarantine
        }
      })?.delegatedWork
    ).toEqual({
      records: [],
      questionRequestsQuarantine: { active, quarantine }
    })
  })

  it('persists errorReportable only when a model-provider error marked it false', () => {
    const base = { ...createSessionWithActivity(undefined), activities: undefined, status: 'error' }

    // A provider error tagged non-reportable at the ACP layer round-trips as false so the reloaded
    // session keeps the report button hidden.
    const providerFailure = normalizeSessionFile({
      ...base,
      error: 'Invalid API key',
      errorReportable: false
    })
    // A reportable failure does not persist the field (default is reportable — no need to store true).
    const reportableFailure = normalizeSessionFile({
      ...base,
      error: 'Agent session could not be created.',
      errorReportable: true
    })
    // An older session file, written before the flag existed, has no field and defaults to reportable.
    const legacy = normalizeSessionFile({ ...base, error: 'Some old failure' })
    // The flag is meaningless without an error and is dropped.
    const noError = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      activities: undefined,
      errorReportable: false
    })

    expect(providerFailure?.errorReportable).toBe(false)
    expect(reportableFailure?.errorReportable).toBeUndefined()
    expect(legacy?.errorReportable).toBeUndefined()
    expect(noError?.errorReportable).toBeUndefined()
  })

  it('persists artifact error event ownership only with an artifact finalization error', () => {
    const base = { ...createSessionWithActivity(undefined), activities: undefined, status: 'error' }
    const artifactFailure = normalizeSessionFile({
      ...base,
      error: 'Generated file finalization failed: move failed',
      artifactErrorEventIds: ['artifact-event-1', 'artifact-event-1']
    })
    const unrelatedFailure = normalizeSessionFile({
      ...base,
      error: 'Invalid API key',
      artifactErrorEventIds: ['artifact-event-1']
    })

    expect(artifactFailure?.artifactErrorEventIds).toEqual(['artifact-event-1'])
    expect(unrelatedFailure?.artifactErrorEventIds).toBeUndefined()
  })

  it('round-trips valid Session details and a bounded generation attempt', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Analyze the observations',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      description: 'A concise description.',
      sessionDetailsSource: 'generated',
      sessionDetailsGeneration: {
        status: 'succeeded',
        sourceMessageId: 'message-1',
        requestId: 'request-1',
        queuedAt: 10,
        startedAt: 11,
        completedAt: 12,
        frameworkId: 'codex',
        providerId: 'provider-1',
        model: 'gpt-test',
        reasoningEffort: 'low',
        usage: { inputTokens: 3, cacheTokens: 2, outputTokens: 1 }
      }
    })

    expect(restored).toMatchObject({
      description: 'A concise description.',
      sessionDetailsSource: 'generated',
      sessionDetailsGeneration: {
        status: 'succeeded',
        sourceMessageId: 'message-1',
        usage: { inputTokens: 3, cacheTokens: 2, outputTokens: 1 }
      }
    })
    expect(restored?.conversationGraph).toBeDefined()
  })

  it('keeps a legacy Session without a description empty instead of deriving from its message', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Do not reuse this as a description',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    expect(restored?.description).toBeUndefined()
  })

  it.each(['queued', 'running'] as const)(
    'drops a %s record when flat messages match but the active graph source differs',
    (status) => {
      const flatMessage = {
        id: 'flat-source',
        role: 'user' as const,
        content: 'Abandoned Branch prompt',
        status: 'complete' as const,
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
      const activeMessage = {
        ...flatMessage,
        id: 'active-source',
        content: 'Active Branch prompt'
      }
      const restored = normalizeSessionFile({
        ...createSessionWithActivity(undefined),
        messages: [flatMessage],
        conversationGraph: createLinearConversationGraph({
          sessionId: 'session-1',
          messages: [activeMessage],
          frameworkId: 'codex',
          createdAt: 1,
          updatedAt: 1
        }),
        sessionDetailsGenerationEligible: true,
        sessionDetailsGeneration: {
          status,
          sourceMessageId: 'flat-source',
          requestId: `request-${status}`,
          queuedAt: 10,
          ...(status === 'running'
            ? {
                startedAt: 11,
                frameworkId: 'codex',
                model: 'model-1',
                reasoningEffort: 'low'
              }
            : {})
        }
      })

      expect(restored?.messages[0]?.id).toBe('active-source')
      expect(restored?.sessionDetailsGeneration).toBeUndefined()
      expect(restored?.sessionDetailsGenerationEligible).toBeUndefined()
    }
  )

  it('preserves a generation record bound to the active graph first qualifying message', () => {
    const activeMessage = {
      id: 'active-source',
      role: 'user' as const,
      content: 'Active Branch prompt',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      messages: [{ ...activeMessage, id: 'compatibility-flat-source' }],
      conversationGraph: createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [activeMessage],
        frameworkId: 'codex',
        createdAt: 1,
        updatedAt: 1
      }),
      sessionDetailsGeneration: {
        status: 'queued',
        sourceMessageId: 'active-source',
        requestId: 'request-active',
        queuedAt: 10
      }
    })

    expect(restored?.messages[0]?.id).toBe('active-source')
    expect(restored?.sessionDetailsGeneration).toMatchObject({
      status: 'queued',
      sourceMessageId: 'active-source'
    })
  })

  it('drops generation authority and eligibility from a Branch Session', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      branchSource: { sessionId: 'parent-session', headMessageId: 'message-1' },
      sessionDetailsGenerationEligible: true,
      sessionDetailsGeneration: {
        status: 'queued',
        sourceMessageId: 'message-1',
        requestId: 'request-1',
        queuedAt: 10
      }
    })

    expect(restored?.branchSource).toBeDefined()
    expect(restored?.sessionDetailsGeneration).toBeUndefined()
    expect(restored?.sessionDetailsGenerationEligible).toBeUndefined()
  })

  it('drops a non-Branch generation record that is not bound to the first qualifying message', () => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'First qualifying message',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      sessionDetailsGenerationEligible: true,
      sessionDetailsGeneration: {
        status: 'queued',
        sourceMessageId: 'not-the-first-message',
        requestId: 'request-mismatch',
        queuedAt: 10
      }
    })

    expect(restored?.branchSource).toBeUndefined()
    expect(restored?.sessionDetailsGeneration).toBeUndefined()
    expect(restored?.sessionDetailsGenerationEligible).toBeUndefined()
  })

  it.each([
    {
      status: 'queued',
      sourceMessageId: 'message-1',
      requestId: 'request-1',
      queuedAt: 10,
      model: 'forbidden-before-admission'
    },
    {
      status: 'running',
      sourceMessageId: 'message-1',
      requestId: 'request-1',
      queuedAt: 10,
      startedAt: 11,
      frameworkId: 'codex',
      model: 'gpt-test'
    },
    {
      status: 'succeeded',
      sourceMessageId: 'message-1',
      requestId: 'request-1',
      queuedAt: 10,
      startedAt: 11,
      completedAt: 12,
      frameworkId: 'codex',
      model: 'gpt-test',
      reasoningEffort: 'low',
      usage: { inputTokens: -1, cacheTokens: 0, outputTokens: 1 }
    },
    {
      status: 'disabled',
      sourceMessageId: 'message-1',
      requestId: 'request-1',
      queuedAt: 10,
      completedAt: 12,
      usageUnavailable: true
    }
  ])('discards malformed generation state %# instead of partially trusting it', (attempt) => {
    const restored = normalizeSessionFile({
      ...createSessionWithActivity(undefined),
      sessionDetailsGeneration: attempt
    })

    expect(restored?.sessionDetailsGeneration).toBeUndefined()
  })

  it('accepts only bounded immutable PDF context snapshots', () => {
    const binding = {
      version: 1,
      bindingId: 'binding-1',
      sourceKind: 'upload-version',
      sourceFileId: 'upload-1',
      sourceVersionId: 'version-1',
      sourceSessionId: 'source-session-1',
      name: 'paper.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 42,
      checksum: 'a'.repeat(64),
      linkedAt: 10
    }
    const snapshot = { version: 1, bindings: [binding] }

    expect(sanitizeSessionPdfContext(snapshot)).toEqual(snapshot)
    expect(
      sanitizeSessionPdfContext({ version: 1, bindings: [{ ...binding, sourceKind: 'local' }] })
    ).toBeUndefined()
    expect(
      sanitizeSessionPdfContext({
        version: 1,
        bindings: [{ ...binding, checksum: 'not-a-checksum' }]
      })
    ).toBeUndefined()
    expect(
      sanitizeSessionPdfContext({
        version: 1,
        bindings: [{ ...binding, name: 'x'.repeat(4097) }]
      })
    ).toBeUndefined()
    expect(
      sanitizeSessionPdfContext({ version: 1, bindings: [binding, binding, binding, binding] })
    ).toBeUndefined()
  })

  it('preserves a valid PDF reading position only on the immutable user Message snapshot', () => {
    const binding = {
      version: 1,
      bindingId: 'binding-1',
      sourceKind: 'upload-version',
      sourceFileId: 'upload-1',
      sourceVersionId: 'version-1',
      sourceSessionId: 'source-session-1',
      name: 'paper.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 42,
      checksum: 'a'.repeat(64),
      linkedAt: 10
    }
    const pdfContext = {
      version: 1,
      bindings: [binding],
      activeBindingId: binding.bindingId,
      readingPosition: { pageNumber: 7, pageCount: 14 }
    }
    const restored = normalizeSessionFile({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Reading',
      cwd: '/workspace',
      status: 'idle',
      runtimeContext: { version: 1, revision: 1, pdfContext },
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Which page am I reading?',
          status: 'complete',
          eventIds: [],
          pdfContext,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    expect(restored?.runtimeContext?.pdfContext).toEqual({ version: 1, bindings: [binding] })
    expect(restored?.messages[0].pdfContext).toMatchObject({
      readingPosition: { pageNumber: 7, pageCount: 14 }
    })
  })
})
