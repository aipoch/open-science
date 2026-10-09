import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: true } }))

import type { AcpRuntimeEvent } from '../../shared/acp'
import {
  materializeSessionConversationGraph,
  normalizeSessionFile,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { createPlanDocumentV1 } from '../../shared/session-plan/contract'
import { applyRuntimeSessionEvents } from '../../shared/runtime-session-projection'
import { SessionPlanDeliveryOwner } from '../acp/session-plan-delivery-owner'
import {
  SessionPersistenceStateOwner,
  SessionRuntimeContextRevisionConflictError
} from '../session-persistence/state-owner'
import { PlanService } from './plan-service'
import { SessionPlanInteractionOwner } from './session-plan-interaction-owner'

const document = createPlanDocumentV1({
  task_summary: 'Demonstrate a plan',
  phases: [
    {
      name: 'Analysis',
      delegations: [
        { name: 'Primary agent', steps: [{ title: 'Analyze', description: 'Analyze the data.' }] }
      ]
    }
  ],
  desired_outputs: ['Analysis'],
  feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
})
const content = JSON.stringify(document, null, 2)
const checksum = createHash('sha256').update(content).digest('hex')

const harness = (
  live = true
): {
  service: PlanService
  deliveries: SessionPlanDeliveryOwner
  read: () => PersistedChatSession
  apply: (events: AcpRuntimeEvent[]) => PersistedChatSession
} => {
  let durable: PersistedChatSession = materializeSessionConversationGraph({
    id: 'dismiss-session',
    projectId: 'project',
    title: 'Plan dismissal',
    cwd: '/workspace',
    status: 'waiting-plan-approval',
    runtimeTranscriptOwner: 'main',
    ...(live ? { activeRun: { promptMessageId: 'original', startedAt: 1 } } : {}),
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: 'original',
        role: 'user',
        content: 'Demonstrate a plan',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    runtimeContext: {
      version: 1,
      revision: 1,
      plan: {
        artifactId: 'plan',
        artifactVersionId: 'plan-version',
        artifactChecksum: checksum,
        document,
        originatingPromptMessageId: 'original',
        approval: 'pending',
        stepStatuses: {}
      }
    }
  })
  const owner = new SessionPersistenceStateOwner({
    repository: {
      loadSessionWithDiagnostics: async () => ({
        status: 'found',
        session: structuredClone(durable)
      }),
      saveSession: async (candidate) => {
        durable = structuredClone(candidate)
        return structuredClone(durable)
      }
    },
    fileIndex: { syncSession: vi.fn(async () => []) },
    assertMutable: vi.fn(),
    notifyFilesChanged: vi.fn(),
    notifyRuntimeContextSessionUpdated: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  })
  const service = new PlanService({
    interactions: new SessionPlanInteractionOwner(),
    writeArtifactForExecution: vi.fn(),
    readArtifactVersion: vi.fn(async () => ({ content, checksum })),
    readRuntimeContext: (projectId, sessionId) => owner.readRuntimeContext(projectId, sessionId),
    patchRuntimeContext: ({ plan, ...command }) =>
      owner.patchRuntimeContext({ ...command, patch: { plan } }),
    isRevisionConflict: (error) => error instanceof SessionRuntimeContextRevisionConflictError,
    persistUserMessage: vi.fn(),
    createCommandId: () => 'rejection-delivery',
    now: () => 3
  })
  const deliveries = new SessionPlanDeliveryOwner({
    readSessionRuntimeContext: (projectId, sessionId) =>
      owner.readRuntimeContext(projectId, sessionId),
    patchSessionRuntimeContext: (command) => owner.patchRuntimeContext(command)
  })
  return {
    service,
    deliveries,
    read: () => structuredClone(durable),
    apply: (events) => {
      const graph = durable.conversationGraph!
      durable = applyRuntimeSessionEvents(
        durable,
        {
          promptMessageId: 'original',
          agentFrameId: graph.rootFrameId,
          messageBranchId: graph.branches[0].id,
          runtimeSegmentId: graph.runtimeSegments[0].id
        },
        events
      )
      return structuredClone(durable)
    }
  }
}

const identity = {
  projectId: 'project',
  sessionId: 'dismiss-session',
  artifactVersionId: 'plan-version',
  expectedRevision: 1
}
const dismiss = async (
  h: ReturnType<typeof harness>,
  live = true
): Promise<PersistedChatSession> => {
  await h.service.respond({ ...identity, decision: 'rejected', interactionIsLive: live })
  return h.read()
}
const event = (
  fields: Partial<Extract<AcpRuntimeEvent, { kind: 'stop' | 'error' | 'message' }>> = {}
): AcpRuntimeEvent => ({
  id: 'done',
  kind: 'stop',
  level: 'info',
  sessionId: identity.sessionId,
  timestamp: Date.now() + 10,
  text: 'end_turn',
  role: 'assistant',
  ...fields
})

describe('Session Plan dismissal execution lifecycle', () => {
  it.each([true, false])(
    'commits rejection with its delivery receipt without inventing cancellation (live=%s)',
    async (live) => {
      const session = await dismiss(harness(live), live)
      expect(session.runtimeContext?.plan).toMatchObject({
        approval: 'rejected',
        artifactVersionId: identity.artifactVersionId,
        artifactChecksum: checksum,
        delivery: {
          commandId: 'rejection-delivery',
          kind: 'rejected-plan',
          state: 'queued',
          originatingPromptMessageId: 'original'
        }
      })
      expect(session.status).toBe(live ? 'running' : 'idle')
      expect(session.resumeRecovery).toBeUndefined()
      expect(session.messages[0].turnOutcome).toBeUndefined()
      expect(session.activeRun).toEqual(
        live ? { promptMessageId: 'original', startedAt: 1 } : undefined
      )
    }
  )

  it('persists the acknowledgement and completes only after the real terminal event', async () => {
    const h = harness()
    await dismiss(h)
    await expect(
      h.deliveries.begin(identity.projectId, identity.sessionId, 'rejection-delivery')
    ).resolves.toBe(true)
    await expect(
      h.deliveries.accept(identity.projectId, identity.sessionId, 'rejection-delivery')
    ).resolves.toBe(true)
    const result = h.apply([
      event({
        id: 'ack',
        kind: 'message',
        messageId: 'acknowledgement',
        role: 'assistant',
        text: 'Plan dismissed. No plan steps were executed.'
      })
    ])
    expect(result.messages.find(({ streamId }) => streamId === 'acknowledgement')?.content).toBe(
      'Plan dismissed. No plan steps were executed.'
    )
    expect(result.messages[0].turnOutcome).toBeUndefined()
    expect(result.activeRun).toBeDefined()
    const completed = h.apply([event({ timestamp: result.updatedAt + 1 })])
    expect(completed.messages[0].turnOutcome?.kind).toBe('completed')
    expect(completed.resumeRecovery).toBeUndefined()
    expect(completed.activeRun).toBeUndefined()
    await expect(
      h.deliveries.clear(identity.projectId, identity.sessionId, 'rejection-delivery')
    ).resolves.toBe(true)
    expect(h.read().runtimeContext?.plan).toMatchObject({ approval: 'rejected', stepStatuses: {} })
    expect(h.read().runtimeContext?.plan?.delivery).toBeUndefined()
    expect(h.read().messages[0].turnOutcome?.kind).toBe('completed')
  })

  it.each(['cancelled', 'connection-lost', 'failed'] as const)(
    'records the real %s while delivering rejection and retains recovery/delivery authority',
    async (terminal) => {
      const h = harness()
      await dismiss(h)
      await h.deliveries.begin(identity.projectId, identity.sessionId, 'rejection-delivery')
      await h.deliveries.accept(identity.projectId, identity.sessionId, 'rejection-delivery')
      const settled = h.apply([
        event(
          terminal === 'cancelled'
            ? { text: 'cancelled' }
            : {
                kind: 'error',
                text: terminal === 'failed' ? 'Provider unavailable' : 'ACP connection closed',
                providerError: true,
                ...(terminal === 'connection-lost' ? { interruptionCause: 'connection-lost' } : {})
              }
        )
      ])
      expect(settled.messages[0].turnOutcome?.kind).toBe(
        terminal === 'connection-lost' ? 'interrupted' : terminal
      )
      expect(settled.resumeRecovery).toEqual(
        terminal === 'failed'
          ? undefined
          : { kind: 'resume-required', cause: terminal, promptMessageId: 'original' }
      )
      await expect(
        h.deliveries.interrupt(identity.projectId, identity.sessionId, 'rejection-delivery')
      ).resolves.toBe(true)
      const restored = normalizeSessionFile(JSON.parse(JSON.stringify(h.read())))!
      expect(restored.messages[0].turnOutcome).toEqual(settled.messages[0].turnOutcome)
      expect(restored.resumeRecovery).toEqual(settled.resumeRecovery)
      expect(restored.runtimeContext?.plan).toMatchObject({
        approval: 'rejected',
        stepStatuses: {},
        delivery: { commandId: 'rejection-delivery', state: 'interrupted' }
      })
      await expect(
        h.deliveries.begin(identity.projectId, identity.sessionId, 'rejection-delivery')
      ).resolves.toBe(false)
      if (terminal === 'cancelled') {
        const late = h.apply([
          event({ id: 'late-done' }),
          event({ id: 'late-message', kind: 'message', role: 'assistant', text: 'Late output' })
        ])
        expect(late.messages).toEqual(settled.messages)
        expect(late.resumeRecovery).toEqual(settled.resumeRecovery)
      }
    }
  )

  it('keeps duplicate rejection idempotent and prohibits executing rejected steps', async () => {
    const h = harness()
    await dismiss(h)
    const before = h.read()
    await expect(h.service.respond({ ...identity, decision: 'rejected' })).resolves.toMatchObject({
      changed: false,
      deliveryCommandId: 'rejection-delivery'
    })
    expect(h.read()).toEqual(before)
    await expect(
      h.service.updateStepStatus({
        ...identity,
        expectedRevision: before.runtimeContext!.revision,
        title: 'Analyze',
        status: 'in_progress'
      })
    ).rejects.toMatchObject({ code: 'plan-not-approved' })
    expect(h.read()).toEqual(before)
  })
})
