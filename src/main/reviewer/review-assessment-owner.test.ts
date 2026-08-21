import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AcpRuntime } from '../acp/runtime'
import type {
  NewCheck,
  Review,
  ReviewCheck,
  ReviewWithChecks,
  TurnScope
} from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ReviewRepository } from './repository'

const harness = vi.hoisted(() => ({
  events: [] as string[],
  inMutation: false,
  submission: undefined as NewCheck[] | undefined,
  submissionAttempted: false,
  submit: undefined as ((checks: NewCheck[]) => Promise<void>) | undefined,
  promptError: undefined as Error | undefined,
  nextUpdate: undefined as (() => Promise<{ kind: string; stopReason?: string }>) | undefined,
  disposeError: undefined as Error | undefined,
  stopError: undefined as Error | undefined,
  bridgeScoped: undefined as boolean | undefined
}))
const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}))

vi.mock('../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger')>()
  return { ...actual, createLogger: () => logSpies }
})

const outsideMutation = (event: string): void => {
  if (harness.inMutation) throw new Error(`${event} ran inside the Session mutation`)
  harness.events.push(event)
}

const insideMutation = (event: string): void => {
  if (!harness.inMutation) throw new Error(`${event} ran outside the Session mutation`)
  harness.events.push(event)
}

const scope: TurnScope = { turnMessageId: 'turn-scope', blocks: [], artifactVersionIds: [] }

vi.mock('./artifact-digest', () => ({
  resolveTurnScopeWithArtifactDigests: async () => {
    outsideMutation('scope')
    return scope
  }
}))

vi.mock('./scope-snapshot', () => ({
  buildReviewScopeSnapshot: () => {
    outsideMutation('snapshot')
    return []
  }
}))

vi.mock('./host-sdk', () => ({
  ReviewerHostServer: class {
    constructor() {
      outsideMutation('host')
    }
  }
}))

vi.mock('./mcp-server', () => ({
  ReviewerMcpServer: class {
    constructor(
      _scope: TurnScope,
      submit: (checks: NewCheck[]) => Promise<void>,
      _host: unknown,
      _mode: 'initial' | 'tracked',
      trackedIds: string[]
    ) {
      outsideMutation(`mcp:create:${trackedIds.join(',')}`)
      harness.submit = submit
    }

    async start(): Promise<void> {
      outsideMutation('mcp:start')
      if (harness.submission) await harness.submit?.(harness.submission)
    }

    async stop(): Promise<void> {
      outsideMutation('mcp:stop')
      if (harness.stopError) throw harness.stopError
    }

    get submissionAttempted(): boolean {
      return harness.submissionAttempted
    }

    toAcpMcpServerConfig(): Record<string, never> {
      outsideMutation('mcp:config')
      return {}
    }
  }
}))

const { runReviewAssessment } = await import('./review-assessment-owner')

type InitialAssessmentOptions = Extract<
  Parameters<typeof runReviewAssessment>[0],
  { mode: 'initial' }
>

const session: PersistedChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Reviewer owner test',
  cwd: join(tmpdir(), 'reviewer-owner-workspace'),
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1
}

const review = (id: string, lifecycle: Review['lifecycle'] = 'running'): Review => ({
  id,
  projectId: 'project-1',
  sessionId: 'session-1',
  turnMessageId: 'turn-group',
  scope,
  lifecycle,
  outcome: lifecycle === 'complete' ? 'pass' : null,
  model: 'reviewer-model',
  reviewerLog: [],
  createdAt: 1,
  updatedAt: 1
})

const trackedCheck: ReviewCheck = {
  id: 'finding-1',
  reviewId: 'source-review',
  status: 'warn',
  resolution: 'open',
  claim: 'Source claim',
  evidence: 'Source evidence',
  sortIndex: 0,
  reflagCount: 0,
  artifactBindingState: 'legacy_unverified'
}

const committedAssessmentReview = (): ReviewWithChecks => ({
  ...review('assessment-review', 'complete'),
  checks: [],
  submittedChecks: [
    {
      kind: 'tracked',
      submissionIndex: 0,
      sourceFindingId: trackedCheck.id,
      dispositionOutcome: 'resolved',
      assessment: {
        status: 'pass',
        claim: 'Fixed',
        evidence: 'Verified',
        sortIndex: 0
      },
      sourceCheck: trackedCheck
    }
  ]
})

const makeRepository = (): ReviewRepository =>
  ({
    createReview: vi.fn(async () => {
      insideMutation('write:create')
      return review('assessment-review')
    }),
    updateReview: vi.fn(async (_id: string, patch: Partial<Review>) => {
      insideMutation(`write:error:${patch.errorMessage}`)
      return { ...review('assessment-review'), ...patch }
    }),
    commitScopedSubmission: vi.fn(async () => {
      insideMutation('write:commit')
      return committedAssessmentReview()
    }),
    getReviewsForProjectSession: vi.fn(async () => {
      outsideMutation('query:reviews')
      return [
        { ...review('source-review', 'complete'), checks: [trackedCheck], submittedChecks: [] },
        committedAssessmentReview()
      ]
    })
  }) as unknown as ReviewRepository

const runtime = (contextModel?: string, sessionModel?: string): AcpRuntime =>
  ({
    ...(contextModel || sessionModel
      ? {
          captureBackend: () => ({
            context: {
              ...(contextModel ? { model: contextModel } : {}),
              supportsImageInput: false
            },
            session: {
              ...(sessionModel ? { model: sessionModel } : {}),
              modelRequired: false
            }
          })
        }
      : {}),
    buildReviewerSession: async () => {
      outsideMutation('acp:build')
      return {
        session: {
          sessionId: 'reviewer-session',
          prompt: () => {
            outsideMutation('acp:prompt')
            if (harness.promptError) throw harness.promptError
          },
          nextUpdate: harness.nextUpdate ?? (async () => ({ kind: 'stop', stopReason: 'end_turn' }))
        }
      }
    },
    disposeReviewerSession: () => {
      outsideMutation('acp:dispose')
      if (harness.disposeError) throw harness.disposeError
      return { rejectedToolCalls: 0, reviewerBridgeScoped: harness.bridgeScoped }
    }
  }) as unknown as AcpRuntime

const mutationRunner = async <Result>(mutation: () => Promise<Result>): Promise<Result> => {
  harness.events.push('mutation:start')
  harness.inMutation = true
  try {
    return await mutation()
  } finally {
    harness.inMutation = false
    harness.events.push('mutation:end')
  }
}

const commonOptions = (
  reviewRepository: ReviewRepository
): Omit<InitialAssessmentOptions, 'mode' | 'onStarted'> => ({
  session,
  sessionId: 'session-1',
  scopeTurnMessageId: 'turn-scope',
  turnMessageId: 'turn-group',
  projectId: 'project-1',
  reviewRepository,
  runSessionMutation: mutationRunner,
  acpRuntime: runtime(),
  artifactStorageRoot: join(tmpdir(), 'reviewer-owner-artifacts'),
  model: 'reviewer-model',
  reviewerTimeoutMs: 1000,
  reviewerMaxUpdates: 100
})

describe('review assessment owner', () => {
  beforeEach(() => {
    harness.events = []
    harness.inMutation = false
    harness.submission = [{ status: 'pass', claim: 'Pass', evidence: 'Verified' }]
    harness.submissionAttempted = false
    harness.submit = undefined
    harness.promptError = undefined
    harness.nextUpdate = undefined
    harness.disposeError = undefined
    harness.stopError = undefined
    harness.bridgeScoped = undefined
    vi.clearAllMocks()
  })

  it('publishes initial running before onStarted and keeps remote work outside mutations', async () => {
    const reviewRepository = makeRepository()
    const result = await runReviewAssessment({
      ...commonOptions(reviewRepository),
      mode: 'initial',
      onReviewUpdate: (value: ReviewWithChecks) => outsideMutation(`publish:${value.lifecycle}`),
      onStarted: () => outsideMutation('started')
    })

    expect(result.review.lifecycle).toBe('complete')
    expect(harness.events).toEqual([
      'scope',
      'snapshot',
      'mutation:start',
      'write:create',
      'mutation:end',
      'publish:running',
      'started',
      'host',
      'mcp:create:',
      'mcp:start',
      'mcp:config',
      'acp:build',
      'acp:prompt',
      'acp:dispose',
      'mcp:stop',
      'mutation:start',
      'write:commit',
      'mutation:end'
    ])
  })

  it('completes an explicit empty initial assessment and classifies its completion log', async () => {
    harness.submission = []
    const reviewRepository = makeRepository()

    const result = await runReviewAssessment({
      ...commonOptions(reviewRepository),
      mode: 'initial'
    })

    expect(result.submittedChecks).toEqual([])
    expect(reviewRepository.commitScopedSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'initial', checks: [], expectedSourceFindingIds: [] })
    )
    expect(logSpies.info).toHaveBeenCalledWith('review complete', {
      reviewId: 'assessment-review',
      outcome: 'pass',
      checkCount: 0,
      model: 'reviewer-model',
      assessmentKind: 'no_checkable_claims'
    })
  })

  it('classifies non-empty initial and tracked assessment completion as assessed', async () => {
    await runReviewAssessment({
      ...commonOptions(makeRepository()),
      mode: 'initial'
    })
    expect(logSpies.info).toHaveBeenCalledWith(
      'review complete',
      expect.objectContaining({ assessmentKind: 'assessed', checkCount: 1 })
    )

    vi.clearAllMocks()
    harness.submission = [
      {
        status: 'pass',
        claim: 'Fixed',
        evidence: 'Verified',
        sourceFindingId: trackedCheck.id
      }
    ]
    await runReviewAssessment({
      ...commonOptions(makeRepository()),
      mode: 'tracked',
      trackedChecks: [trackedCheck]
    })
    expect(logSpies.info).toHaveBeenCalledWith(
      'scoped re-review complete',
      expect.objectContaining({ assessmentKind: 'assessed', checkCount: 1 })
    )
  })

  it('reconciles the Review model with the backend pinned by the runtime', async () => {
    const reviewRepository = makeRepository()
    vi.mocked(reviewRepository.commitScopedSubmission).mockImplementation(async () => ({
      ...committedAssessmentReview(),
      model: 'actual-runtime-model'
    }))
    const updates: ReviewWithChecks[] = []

    await runReviewAssessment({
      ...commonOptions(reviewRepository),
      acpRuntime: runtime('actual-runtime-model'),
      mode: 'initial',
      onReviewUpdate: (value) => updates.push(value)
    })

    expect(reviewRepository.updateReview).toHaveBeenCalledWith('assessment-review', {
      model: 'actual-runtime-model'
    })
    expect(updates).toContainEqual(
      expect.objectContaining({ lifecycle: 'running', model: 'actual-runtime-model' })
    )
    expect(logSpies.info).toHaveBeenCalledWith(
      'review complete',
      expect.objectContaining({ model: 'actual-runtime-model' })
    )
  })

  it('aborts an active initial Reviewer session and persists its existing error lifecycle', async () => {
    harness.submission = undefined
    harness.nextUpdate = () => new Promise(() => {})
    const reviewRepository = makeRepository()
    const controller = new AbortController()

    const assessment = runReviewAssessment({
      ...commonOptions(reviewRepository),
      mode: 'initial',
      abortSignal: controller.signal
    })
    await vi.waitFor(() => expect(harness.events).toContain('acp:prompt'))
    controller.abort()

    const result = await assessment
    expect(result.review).toMatchObject({
      lifecycle: 'error',
      errorMessage: 'reviewer session was aborted before stopping'
    })
    expect(harness.events).toContain('acp:dispose')
    expect(harness.events).toContain('mcp:stop')
  })

  it('records the selected session model instead of the context tokenization model', async () => {
    const reviewRepository = makeRepository()

    await runReviewAssessment({
      ...commonOptions(reviewRepository),
      acpRuntime: runtime('tokenization-model', 'selected-runtime-model'),
      mode: 'initial'
    })

    expect(reviewRepository.updateReview).toHaveBeenCalledWith('assessment-review', {
      model: 'selected-runtime-model'
    })
  })

  it('does not retry after submit_findings was attempted', async () => {
    harness.submission = undefined
    harness.submissionAttempted = true
    const result = await runReviewAssessment({
      ...commonOptions(makeRepository()),
      mode: 'initial'
    })

    expect(result.review.lifecycle).toBe('error')
    expect(harness.events.filter((event) => event === 'acp:prompt')).toHaveLength(1)
  })

  it('does not retry a cancelled reviewer turn', async () => {
    harness.submission = undefined
    harness.nextUpdate = async () => ({ kind: 'stop', stopReason: 'cancelled' })
    const result = await runReviewAssessment({
      ...commonOptions(makeRepository()),
      mode: 'initial'
    })

    expect(result.review.lifecycle).toBe('error')
    expect(harness.events.filter((event) => event === 'acp:prompt')).toHaveLength(1)
  })

  it('disposes a built session when the pinned model cannot be persisted', async () => {
    const reviewRepository = makeRepository()
    const updateReview = vi.mocked(reviewRepository.updateReview)
    const persistUpdate = updateReview.getMockImplementation()
    updateReview.mockImplementation(async (id, patch) => {
      if (patch.model) {
        insideMutation('write:model-error')
        throw new Error('model persistence failed')
      }
      if (!persistUpdate) throw new Error('missing repository test implementation')
      return persistUpdate(id, patch)
    })

    const result = await runReviewAssessment({
      ...commonOptions(reviewRepository),
      acpRuntime: runtime('actual-runtime-model'),
      mode: 'initial'
    })

    expect(result.review.lifecycle).toBe('error')
    expect(result.review.errorMessage).toBe('model persistence failed')
    expect(harness.events).toContain('acp:dispose')
  })

  it('stops MCP independently and preserves session then bridge error precedence', async () => {
    const reviewRepository = makeRepository()
    harness.promptError = new Error('prompt failed')
    harness.disposeError = new Error('dispose failed')
    harness.stopError = new Error('stop failed')

    const sessionFailure = await runReviewAssessment({
      ...commonOptions(reviewRepository),
      mode: 'initial'
    })
    expect(sessionFailure.review.errorMessage).toBe('prompt failed')
    expect(harness.events).toContain('acp:dispose')
    expect(harness.events).toContain('mcp:stop')

    harness.events = []
    harness.submission = undefined
    harness.promptError = undefined
    harness.disposeError = undefined
    harness.stopError = undefined
    harness.bridgeScoped = false
    const bridgeFailure = await runReviewAssessment({
      ...commonOptions(makeRepository()),
      mode: 'initial'
    })
    expect(bridgeFailure.review.errorMessage).toBe(
      'Reviewer request was not constrained to the reviewer-only tool scope.'
    )
  })

  it('commits tracked Review Checks atomically before publishing source then assessment', async () => {
    harness.submission = [
      {
        status: 'pass',
        claim: 'Fixed',
        evidence: 'Verified',
        sourceFindingId: trackedCheck.id
      }
    ]
    const reviewRepository = makeRepository()
    const published: ReviewWithChecks[] = []
    const result = await runReviewAssessment({
      ...commonOptions(reviewRepository),
      mode: 'tracked',
      trackedChecks: [trackedCheck],
      onReviewUpdate: (value: ReviewWithChecks) => {
        published.push(value)
        outsideMutation(`publish:${value.id}`)
      }
    })

    expect(result.submittedChecks).toEqual(harness.submission)
    expect(reviewRepository.commitScopedSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'tracked', expectedSourceFindingIds: [trackedCheck.id] })
    )
    expect(harness.events).toEqual(
      expect.arrayContaining([
        'mcp:create:finding-1',
        'mutation:start',
        'write:commit',
        'mutation:end',
        'query:reviews'
      ])
    )
    expect(harness.events.indexOf('publish:source-review')).toBeLessThan(
      harness.events.lastIndexOf('publish:assessment-review')
    )
    const commandRead = await reviewRepository.getReviewsForProjectSession('project-1', 'session-1')
    expect(published.findLast((candidate) => candidate.id === 'assessment-review')).toEqual(
      commandRead.find((candidate) => candidate.id === 'assessment-review')
    )
  })
})
