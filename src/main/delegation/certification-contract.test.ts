import { describe, expect, it, vi } from 'vitest'

import type { ArtifactFile } from '../../shared/artifacts'
import type { ReviewWithChecks } from '../../shared/reviewer'
import {
  DELEGATED_WORK_CERTIFICATION_JOURNEYS,
  evaluateDelegatedWorkCertification,
  type NativeDelegationAudit
} from './certification'
import {
  createInMemoryDelegatedWorkRecords,
  type AuthenticatedDelegateCaller,
  type DelegatedArtifactScope,
  type DelegatedReviewProjectionScope,
  type DurableDelegatedWork
} from './durable-delegated-work'
import { createTestDurableDelegatedWork as createDurableDelegatedWork } from './durable-delegated-work-test-fixture'
import { createDeterministicDelegateExecution } from './deterministic-execution'
import type {
  DelegateExecution,
  DelegateExecutionEvent,
  DelegateExecutionInput,
  DelegatePermissionResponse
} from './execution-port'

type DelegatedWorkCertificationDriver = Readonly<{
  waitForStart(attemptId: string): Promise<void>
  startedInputs(): readonly DelegateExecutionInput[]
  accept(attemptId: string): Promise<void>
  emit(attemptId: string, event: DelegateExecutionEvent): Promise<void>
  complete(attemptId: string, response: string): Promise<void>
  fail(attemptId: string, error: Error): Promise<void>
  deliveredMessages(attemptId: string): readonly string[]
  permissionResponses(attemptId: string): readonly DelegatePermissionResponse[]
}>

type DelegatedWorkCertificationAdapter = Readonly<{
  execution: DelegateExecution
  driver: DelegatedWorkCertificationDriver
  nativeEntryPoints: readonly NativeDelegationAudit[]
}>

type CertificationAdapterFactory = (
  options?: Readonly<{ capacity?: number }>
) => DelegatedWorkCertificationAdapter

const session = { projectId: 'project-certification', sessionId: 'session-certification' } as const
const caller: AuthenticatedDelegateCaller = {
  session,
  frameId: 'root-frame',
  role: 'main',
  originMessageId: 'root-message',
  toolInvocationId: 'certification-call'
}

const artifactFor = (scope: DelegatedArtifactScope): ArtifactFile => ({
  id: `version-${scope.attemptId}`,
  artifactId: `artifact-${scope.agentFrameId}`,
  versionId: `version-${scope.attemptId}`,
  versionNumber: 1,
  checksum: `checksum-${scope.attemptId}`,
  createdAt: '2026-08-07T00:00:00.000Z',
  projectId: scope.session.projectId,
  sessionId: scope.session.sessionId,
  runId: scope.executionId,
  name: `${scope.agentFrameId}.md`,
  path: `/certification/${scope.agentFrameId}.md`,
  fileUrl: `file:///certification/${scope.agentFrameId}.md`,
  size: 10,
  mtimeMs: 1
})

type ModuleHarness = Readonly<{
  work: DurableDelegatedWork
  reopen(): DurableDelegatedWork
  parentDeliveries: Array<
    Readonly<{ sourceFrameId: string; sourceAttemptId: string; text: string }>
  >
  artifactScopes: DelegatedArtifactScope[]
  reviewScopes: DelegatedReviewProjectionScope[]
}>

const createModuleHarness = (execution: DelegateExecution): ModuleHarness => {
  const records = createInMemoryDelegatedWorkRecords({
    session,
    rootFrameId: caller.frameId,
    originMessageId: caller.originMessageId
  })
  const counters = { frame: 0, attempt: 0, message: 0, runtime: 0, question: 0 }
  const parentDeliveries: ModuleHarness['parentDeliveries'] = []
  const artifactScopes: DelegatedArtifactScope[] = []
  const artifacts = new Map<string, ArtifactFile>()
  const reviewScopes: DelegatedReviewProjectionScope[] = []
  let clock = 1
  const options: Parameters<typeof createDurableDelegatedWork>[0] = {
    execution,
    records,
    now: () => clock++,
    createId: (kind) => `${kind}-${++counters[kind]}`,
    collectPollIntervalMs: 0,
    deliverToParent: async (delivery) => {
      await delivery.startDispatch()
      parentDeliveries.push({
        sourceFrameId: delivery.sourceFrameId,
        sourceAttemptId: delivery.sourceAttemptId,
        text: delivery.text
      })
      return 'provider_prompt_accepted'
    },
    artifactEvidence: {
      async open(scope) {
        artifactScopes.push(scope)
        artifacts.set(scope.attemptId, artifactFor(scope))
        return {
          execution: { currentRunFile: `/runs/${scope.attemptId}.json` },
          finalize: async () => undefined,
          dispose: async () => undefined
        }
      },
      async project(scope) {
        const artifact = artifacts.get(scope.attemptId)
        return artifact ? [artifact] : []
      }
    },
    reviewEvidence: {
      async project(scope) {
        const existing = reviewScopes.findIndex(({ attemptId }) => attemptId === scope.attemptId)
        if (existing < 0) reviewScopes.push(scope)
        else reviewScopes[existing] = scope
        return [
          {
            id: `review-${scope.attemptId}`,
            projectId: scope.session.projectId,
            sessionId: scope.session.sessionId,
            turnMessageId: scope.terminalMessageId,
            scope: {
              turnMessageId: scope.terminalMessageId,
              agentFrameId: scope.agentFrameId,
              messageBranchId: scope.messageBranchId,
              blocks: [],
              artifactVersionIds: [...scope.artifactVersionIds]
            },
            lifecycle: 'complete',
            outcome: 'pass',
            model: 'certification-reviewer',
            reviewerLog: [],
            createdAt: 1,
            updatedAt: 2,
            checks: []
          } satisfies ReviewWithChecks
        ]
      }
    }
  }
  const create = (): DurableDelegatedWork => createDurableDelegatedWork(options)
  return {
    work: create(),
    reopen: create,
    parentDeliveries,
    artifactScopes,
    reviewScopes
  }
}

const withInvocation = (
  value: string,
  additions: Partial<AuthenticatedDelegateCaller> = {}
): AuthenticatedDelegateCaller => ({ ...caller, ...additions, toolInvocationId: value })

/**
 * Shared observable contract for framework certification. Factories may wrap the deterministic fake
 * or the production ACP adapter; the journeys only call the public Delegated Work Module Interface.
 */
const delegatedWorkCertificationContract = (createAdapter: CertificationAdapterFactory): void => {
  describe('cross-framework delegated-work certification contract', () => {
    it('audits every framework-native Task, Agent, and multi-agent bypass', () => {
      const adapter = createAdapter()
      const journeys = Object.fromEntries(
        DELEGATED_WORK_CERTIFICATION_JOURNEYS.map((journey) => [
          journey,
          { status: 'passed' as const }
        ])
      )

      expect(
        evaluateDelegatedWorkCertification({
          frameworkId: 'adapter-under-test',
          journeys,
          nativeEntryPoints: adapter.nativeEntryPoints
        })
      ).toEqual({ frameworkId: 'adapter-under-test', status: 'certified', diagnostics: [] })
    })

    it('owns the single blocking journey and returns evidence for Main synthesis', async () => {
      const { execution, driver } = createAdapter()
      const { work } = createModuleHarness(execution)
      const blocking = work.delegate(caller, { task: 'trace one claim', name: 'Single trace' })
      await driver.waitForStart('attempt-1')

      await expect(work.children(caller)).resolves.toEqual([
        {
          frameId: 'frame-1',
          attemptId: 'attempt-1',
          title: 'Single trace',
          name: 'Single trace',
          agentName: 'Main Agent',
          status: 'running'
        }
      ])
      await driver.accept('attempt-1')
      await driver.complete('attempt-1', 'trace complete')

      await expect(blocking).resolves.toMatchObject({
        kind: 'results',
        children: [
          {
            frameId: 'frame-1',
            attemptId: 'attempt-1',
            status: 'completed',
            response: 'trace complete',
            artifactsCreated: [expect.objectContaining({ artifactId: 'artifact-frame-1' })]
          }
        ]
      })
    })

    it('keeps detached results ordered while completion, error, and cancellation stay isolated', async () => {
      const { execution, driver } = createAdapter({ capacity: 3 })
      const { work } = createModuleHarness(execution)
      const receipt = await work.delegate(
        caller,
        [
          { task: 'complete', name: 'complete' },
          { task: 'fail', name: 'fail' },
          { task: 'cancel', name: 'cancel' }
        ],
        { wait: false }
      )
      expect(receipt).toMatchObject({ kind: 'receipts' })
      await Promise.all(['attempt-1', 'attempt-2', 'attempt-3'].map(driver.waitForStart))
      expect(driver.startedInputs().map(({ attemptId }) => attemptId)).toEqual([
        'attempt-1',
        'attempt-2',
        'attempt-3'
      ])

      await Promise.all(
        ['attempt-1', 'attempt-2', 'attempt-3'].map((attemptId) => driver.accept(attemptId))
      )
      await driver.complete('attempt-1', 'usable result')
      await driver.fail('attempt-2', new Error('provider failed'))
      await work.stopChildren(withInvocation('stop-third'), ['frame-3'])

      await expect(work.collect(caller, ['frame-3', 'frame-1', 'frame-2'])).resolves.toMatchObject([
        { frameId: 'frame-3', status: 'cancelled', cancellationReason: 'main_agent_stop' },
        { frameId: 'frame-1', status: 'completed', response: 'usable result' },
        { frameId: 'frame-2', status: 'error', error: { code: 'execution_failure' } }
      ])
    })

    it('admits arrays all-or-nothing and starts accepted siblings in parallel', async () => {
      const rejected = createAdapter({ capacity: 2 })
      const rejectedModule = createModuleHarness(rejected.execution)
      await expect(
        rejectedModule.work.delegate(
          caller,
          [
            { task: 'one', name: 'one' },
            { task: 'two', name: 'two' },
            { task: 'three', name: 'three' }
          ],
          {
            wait: false
          }
        )
      ).rejects.toMatchObject({ code: 'capacity' })
      await expect(rejectedModule.work.children(caller)).resolves.toEqual([])
      expect(rejected.driver.startedInputs()).toEqual([])

      const accepted = createAdapter({ capacity: 2 })
      const acceptedModule = createModuleHarness(accepted.execution)
      await acceptedModule.work.delegate(
        caller,
        [
          { task: 'one', name: 'one' },
          { task: 'two', name: 'two' }
        ],
        {
          wait: false
        }
      )
      await Promise.all(['attempt-1', 'attempt-2'].map(accepted.driver.waitForStart))
      expect(accepted.driver.startedInputs().map(({ task }) => task)).toEqual(['one', 'two'])
      await accepted.driver.accept('attempt-1')
      await accepted.driver.accept('attempt-2')
      await accepted.driver.fail('attempt-1', new Error('first failed'))
      await accepted.driver.complete('attempt-2', 'second survived')
      await expect(
        acceptedModule.work.collect(caller, ['frame-1', 'frame-2'])
      ).resolves.toMatchObject([
        { status: 'error' },
        { status: 'completed', response: 'second survived' }
      ])
    })

    it('correlates approve/deny cards by Frame and Attempt and fences permission-stop races', async () => {
      const { execution, driver } = createAdapter({ capacity: 2 })
      const { work } = createModuleHarness(execution)
      await work.delegate(
        caller,
        [
          { task: 'permission one', name: 'permission one' },
          { task: 'permission two', name: 'permission two' }
        ],
        {
          wait: false
        }
      )
      await Promise.all(['attempt-1', 'attempt-2'].map(driver.waitForStart))
      await driver.accept('attempt-1')
      await driver.accept('attempt-2')
      for (const [attemptId, requestId] of [
        ['attempt-1', 'permission-1'],
        ['attempt-2', 'permission-2']
      ] as const) {
        await driver.emit(attemptId, {
          kind: 'permission',
          awaiting: true,
          requestId,
          title: `Read for ${attemptId}`,
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
          ]
        })
      }
      await expect(work.rootPermissionRequests(session)).resolves.toMatchObject([
        { frameId: 'frame-1', attemptId: 'attempt-1', requestId: 'permission-1' },
        { frameId: 'frame-2', attemptId: 'attempt-2', requestId: 'permission-2' }
      ])
      await work.respondToPermission(session, {
        frameId: 'frame-1',
        attemptId: 'attempt-1',
        requestId: 'permission-1',
        optionId: 'allow'
      })
      expect(driver.permissionResponses('attempt-1')).toEqual([
        { requestId: 'permission-1', optionId: 'allow' }
      ])
      expect(driver.permissionResponses('attempt-2')).toEqual([])

      await work.respondToPermission(session, {
        frameId: 'frame-2',
        attemptId: 'attempt-2',
        requestId: 'permission-2',
        optionId: 'deny'
      })
      expect(driver.permissionResponses('attempt-2')).toEqual([
        { requestId: 'permission-2', optionId: 'deny' }
      ])
      await driver.emit('attempt-1', {
        kind: 'permission',
        awaiting: true,
        requestId: 'permission-race',
        title: 'Race with Stop',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
      })

      await work.stopChildren(withInvocation('stop-first'), ['frame-1'])
      await expect(
        work.respondToPermission(session, {
          frameId: 'frame-1',
          attemptId: 'attempt-1',
          requestId: 'permission-race',
          optionId: 'allow'
        })
      ).rejects.toMatchObject({ code: 'conflict' })
      await driver.complete('attempt-2', 'denied safely')
    })

    it('revokes stopped Attempts, fences late events, and recovers without automatic replay', async () => {
      const { execution, driver } = createAdapter({ capacity: 2 })
      const harness = createModuleHarness(execution)
      await harness.work.delegate(
        caller,
        [
          { task: 'stop me', name: 'stop me' },
          { task: 'interrupt me', name: 'interrupt me' }
        ],
        {
          wait: false
        }
      )
      await Promise.all(['attempt-1', 'attempt-2'].map(driver.waitForStart))
      await driver.accept('attempt-1')
      await driver.accept('attempt-2')
      await harness.work.stopChildren(withInvocation('stop-first'), ['frame-1'])
      await driver.emit('attempt-1', {
        kind: 'permission',
        awaiting: true,
        requestId: 'late-permission',
        title: 'late',
        options: []
      })
      expect(await harness.work.rootPermissionRequests(session)).toEqual([])

      const startsBeforeRecovery = driver.startedInputs().length
      const reopened = harness.reopen()
      await expect(reopened.recoverInterrupted()).resolves.toMatchObject({
        interrupted: [
          {
            frameId: 'frame-2',
            attemptId: 'attempt-2',
            status: 'cancelled',
            cancellationReason: 'runtime_interrupted'
          }
        ]
      })
      expect(driver.startedInputs()).toHaveLength(startsBeforeRecovery)

      const cascadeAdapter = createAdapter({ capacity: 2 })
      const cascade = createModuleHarness(cascadeAdapter.execution)
      await cascade.work.delegate(
        caller,
        [
          { task: 'terminal sibling', name: 'terminal sibling' },
          { task: 'cascade', name: 'cascade' }
        ],
        {
          wait: false
        }
      )
      await Promise.all(['attempt-1', 'attempt-2'].map(cascadeAdapter.driver.waitForStart))
      await cascadeAdapter.driver.accept('attempt-1')
      await cascadeAdapter.driver.accept('attempt-2')
      await cascadeAdapter.driver.complete('attempt-1', 'already complete')
      await cascade.work.collect(caller, ['frame-1'])
      await expect(cascade.work.stopSession(session)).resolves.toEqual([
        { frameId: 'frame-2', status: 'cancelled' }
      ])
      await expect(cascade.work.collect(caller, ['frame-1', 'frame-2'])).resolves.toMatchObject([
        { status: 'completed' },
        { status: 'cancelled', cancellationReason: 'session_stop' }
      ])
    })

    it('delivers running and upward messages, continues terminal children, and denies siblings', async () => {
      const { execution, driver } = createAdapter({ capacity: 2 })
      const harness = createModuleHarness(execution)
      await harness.work.delegate(
        caller,
        [
          { task: 'first', name: 'first' },
          { task: 'sibling', name: 'sibling' }
        ],
        {
          wait: false
        }
      )
      await Promise.all(['attempt-1', 'attempt-2'].map(driver.waitForStart))
      await driver.accept('attempt-1')
      await driver.accept('attempt-2')
      await harness.work.sendMessage(withInvocation('downward'), 'frame-1', 'extra context')

      const childCaller = withInvocation('upward', {
        frameId: 'frame-1',
        role: 'delegate',
        attemptId: 'attempt-1'
      })
      await harness.work.sendMessage(childCaller, 'parent', 'need a source', { kind: 'question' })
      expect(harness.parentDeliveries).toEqual([
        { sourceFrameId: 'frame-1', sourceAttemptId: 'attempt-1', text: 'need a source' }
      ])
      await expect(
        harness.work.sendMessage(
          { ...childCaller, toolInvocationId: 'cross-talk' },
          'frame-2',
          'cross-talk'
        )
      ).rejects.toMatchObject({ code: 'authorization' })

      await driver.complete('attempt-1', 'first done')
      await harness.work.collect(caller, ['frame-1'])
      expect(driver.deliveredMessages('attempt-1')).toEqual(['extra context'])
      await expect(
        harness.work.sendMessage(withInvocation('continuation'), 'frame-1', 'continue safely')
      ).resolves.toMatchObject({
        disposition: 'continued',
        target_frame_id: 'frame-1',
        continuation_attempt_id: 'attempt-3',
        status: 'queued'
      })
      await driver.waitForStart('attempt-3')
      expect(driver.startedInputs().at(-1)).toMatchObject({
        frameId: 'frame-1',
        attemptId: 'attempt-3',
        continuation: true
      })
      await harness.work.stopSession(session)
    })

    it('attributes parallel Artifact, Notebook-lane, and Review evidence to exact execution scopes', async () => {
      const { execution, driver } = createAdapter({ capacity: 2 })
      const harness = createModuleHarness(execution)
      await harness.work.delegate(
        caller,
        [
          { task: 'evidence one', name: 'evidence one' },
          { task: 'evidence two', name: 'evidence two' }
        ],
        {
          wait: false
        }
      )
      await Promise.all(['attempt-1', 'attempt-2'].map(driver.waitForStart))
      await driver.accept('attempt-1')
      await driver.accept('attempt-2')
      await driver.complete('attempt-2', 'second evidence')
      await driver.complete('attempt-1', 'first evidence')
      await harness.work.collect(caller, ['frame-1', 'frame-2'])
      await harness.work.readAgentFrame(session, 'frame-1')
      await harness.work.readAgentFrame(session, 'frame-2')

      expect(
        harness.artifactScopes.map(({ attemptId, agentFrameId, runtimeSegmentId }) => ({
          attemptId,
          agentFrameId,
          runtimeSegmentId
        }))
      ).toEqual([
        { attemptId: 'attempt-1', agentFrameId: 'frame-1', runtimeSegmentId: 'runtime-1' },
        { attemptId: 'attempt-2', agentFrameId: 'frame-2', runtimeSegmentId: 'runtime-2' }
      ])
      expect(new Set(harness.artifactScopes.map(({ agentFrameId }) => agentFrameId)).size).toBe(2)
      expect(
        driver.startedInputs().map(({ frameId, runtimeSegmentId }) => ({
          frameId,
          runtimeSegmentId
        }))
      ).toEqual([
        { frameId: 'frame-1', runtimeSegmentId: 'runtime-1' },
        { frameId: 'frame-2', runtimeSegmentId: 'runtime-2' }
      ])
      expect(harness.reviewScopes).toEqual([
        expect.objectContaining({
          attemptId: 'attempt-1',
          agentFrameId: 'frame-1',
          messageBranchId: 'branch-frame-1',
          artifactVersionIds: ['version-attempt-1']
        }),
        expect.objectContaining({
          attemptId: 'attempt-2',
          agentFrameId: 'frame-2',
          messageBranchId: 'branch-frame-2',
          artifactVersionIds: ['version-attempt-2']
        })
      ])
    })
  })
}

const createFakeAdapter: CertificationAdapterFactory = (options) => {
  const execution = createDeterministicDelegateExecution(options?.capacity)
  return {
    execution,
    nativeEntryPoints: [
      { entryPoint: 'task', status: 'not-present' },
      { entryPoint: 'agent', status: 'not-present' },
      { entryPoint: 'multi-agent', status: 'not-present' }
    ],
    driver: {
      waitForStart: (attemptId) =>
        vi.waitFor(() =>
          expect(execution.controls().some(({ input }) => input.attemptId === attemptId)).toBe(true)
        ),
      startedInputs: () => execution.controls().map(({ input }) => input),
      accept: async (attemptId) => execution.control(attemptId).accept(),
      emit: async (attemptId, event) => execution.control(attemptId).emit(event),
      complete: async (attemptId, response) => execution.control(attemptId).complete(response),
      fail: async (attemptId, error) => execution.control(attemptId).fail(error),
      deliveredMessages: (attemptId) => execution.control(attemptId).deliveredMessages(),
      permissionResponses: (attemptId) => execution.control(attemptId).permissionResponses()
    }
  }
}

delegatedWorkCertificationContract(createFakeAdapter)

export { delegatedWorkCertificationContract }
export type {
  CertificationAdapterFactory,
  DelegatedWorkCertificationAdapter,
  DelegatedWorkCertificationDriver
}
