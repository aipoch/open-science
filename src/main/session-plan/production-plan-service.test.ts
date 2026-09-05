import { describe, expect, it, vi } from 'vitest'

import { createHash } from 'node:crypto'
import {
  sanitizeSessionRuntimeContext,
  type SessionRuntimeContext,
  type PersistedChatMessage
} from '../../shared/session-persistence'
import { createPlanDocumentV1 } from '../../shared/session-plan/contract'
import { SessionPlanInteractionOwner } from './session-plan-interaction-owner'
import {
  createProductionPlanService,
  readManagedArtifactVersion,
  type ProductionPlanServiceDependencies
} from './production-plan-service'

describe('readManagedArtifactVersion', () => {
  it('reads an exact Artifact Version, including an unpublished one, through a lease and closes it', async () => {
    const bytes = Buffer.from('{"schema_version":1}')
    const close = vi.fn().mockResolvedValue(undefined)
    const verifyUnchanged = vi.fn().mockResolvedValue(undefined)
    const openUnpublishedVersion = vi.fn().mockResolvedValue({
      size: bytes.byteLength,
      logicalFile: { sessionId: 'session-1' },
      version: { checksum: 'a'.repeat(64) },
      readRange: vi.fn().mockResolvedValue(new Uint8Array(bytes)),
      verifyUnchanged,
      close
    })

    await expect(
      readManagedArtifactVersion({ openUnpublishedVersion } as never, {
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        artifactVersionId: 'version-2'
      })
    ).resolves.toEqual({ content: '{"schema_version":1}', checksum: 'a'.repeat(64) })

    expect(openUnpublishedVersion).toHaveBeenCalledWith(
      { source: 'artifact', projectId: 'project-1', fileId: 'artifact-1' },
      'version-2'
    )
    expect(verifyUnchanged).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects a Version owned by another Session and still closes its lease', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const openUnpublishedVersion = vi.fn().mockResolvedValue({
      size: 2,
      logicalFile: { sessionId: 'session-2' },
      version: { checksum: 'b'.repeat(64) },
      readRange: vi.fn(),
      verifyUnchanged: vi.fn(),
      close
    })

    await expect(
      readManagedArtifactVersion({ openUnpublishedVersion } as never, {
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        artifactVersionId: 'version-2'
      })
    ).rejects.toThrow(/different Session/i)
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('production Plan feedback persistence', () => {
  it.each([undefined, 'queued', 'delivering', 'accepted', 'interrupted'] as const)(
    'P01 persists the returned feedback command when the previous receipt is %s',
    async (previousState) => {
      const document = createPlanDocumentV1({
        task_summary: 'Analyze one dataset',
        phases: [
          {
            name: 'Analysis',
            delegations: [
              {
                name: 'Primary agent',
                steps: [{ title: 'Analyze', description: 'Produce results.' }]
              }
            ]
          }
        ],
        desired_outputs: ['Result'],
        feasibility: { confidence: 'high', rationale: 'Ready.' }
      })
      let context: SessionRuntimeContext = {
        version: 1,
        revision: 1,
        plan: {
          artifactId: 'artifact-1',
          artifactVersionId: 'version-1',
          artifactChecksum: createHash('sha256')
            .update(JSON.stringify(document, null, 2))
            .digest('hex'),
          document,
          originatingPromptMessageId: 'prompt-1',
          approval: 'pending',
          stepStatuses: {},
          ...(previousState
            ? {
                reviewFeedbackMessageId: 'old-feedback',
                delivery: {
                  commandId: 'old-command',
                  kind: 'review-feedback',
                  state: previousState,
                  originatingPromptMessageId: 'old-feedback',
                  createdAt: 1
                }
              }
            : {})
        }
      }
      const messages: PersistedChatMessage[] = []
      const append = vi.fn<
        ProductionPlanServiceDependencies['sessions']['appendUserMessageToInteraction']
      >(async (input) => {
        const message: PersistedChatMessage = {
          id: 'new-feedback',
          role: 'user',
          content: input.content,
          status: 'complete',
          responseToMessageId: input.interactionId,
          eventIds: [],
          createdAt: 42,
          updatedAt: 42
        }
        const patch = input.runtimeContextPatch!
        expect(patch.expectedRevision).toBe(context.revision)
        const next = sanitizeSessionRuntimeContext({
          ...context,
          ...(typeof patch.patch === 'function' ? patch.patch(message) : patch.patch),
          revision: context.revision + 1
        })
        if (!next) throw new Error('Session runtime context patch is not JSON-safe.')
        context = next
        messages.push(message)
        return message
      })
      const interactions = new SessionPlanInteractionOwner()
      interactions.register({
        sessionId: 'session-1',
        artifactVersionId: 'version-1',
        interactionId: 'prompt-1'
      })
      const service = createProductionPlanService({
        interactions,
        artifactTurns: { handleForExecution: vi.fn(), write: vi.fn() },
        managedFileVersions: { openUnpublishedVersion: vi.fn() },
        sessions: {
          readSessionRuntimeContext: vi.fn(async () => structuredClone(context)),
          appendUserMessageToInteraction: append
        } as unknown as ProductionPlanServiceDependencies['sessions']
      })
      const result = await service.respond({
        projectId: 'project-1',
        sessionId: 'session-1',
        feedback: 'Split the analysis by cohort.'
      })
      if (!('kind' in result)) throw new Error('Expected feedback result')
      expect(messages).toHaveLength(1)
      expect(context.plan?.reviewFeedbackMessageId).toBe(result.message.id)
      expect(context.plan?.delivery).toEqual({
        commandId: result.deliveryCommandId,
        kind: 'review-feedback',
        state: 'queued',
        originatingPromptMessageId: result.message.id,
        createdAt: expect.any(Number)
      })
      expect(context.plan).not.toHaveProperty('continuation')
    }
  )
})
