import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: true } }))

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import { materializeSessionConversationGraph } from '../../shared/session-persistence'
import {
  CompletionHandoffLifecycle,
  FileCompletionHandoffRepository
} from '../agents/completion-handoff-lifecycle'
import { opencodeFramework } from '../agent-framework'
import { createClaudeCodeCompletionGateRuntime } from '../agents/claude-code-handoff'
import { createOpenCodeImmediateHandoffRuntime } from './opencode-immediate-handoff'
import { RuntimeSessionOwner } from '../session-persistence/runtime-session-owner'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { SessionRepository } from '../session-persistence/repository'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { UploadRepository } from '../uploads/repository'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { initDataRoot } from '../storage-root'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { AcpRuntime } from './runtime.test-utils'
import { AcpRuntimeCoordinator } from './runtime-coordinator'
import { withApprovedHandoffOutcome } from './approved-handoff-outcome'
import {
  CompletionGateCoordinator,
  type CompletionDisposition,
  type TrustedToolCompletionContext
} from '../agents/completion-gate'

class ProviderProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill(): boolean {
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const context: TrustedToolCompletionContext = {
  sessionId: 'handoff-session',
  turnId: 'tool-turn',
  toolInvocationId: 'tool-1',
  controlInvocationGeneration: 1
}
const handoff: Extract<CompletionDisposition, { kind: 'capture-for-handoff' }> = {
  kind: 'capture-for-handoff',
  targetName: 'Specialist',
  generation: 1,
  envelope: { kind: 'returned', value: { status: 'approved' } }
}

describe('production approved Handoff outcome composition', () => {
  it.each([
    ['opencode', false],
    ['opencode', true],
    ['claude-code', false],
    ['claude-code', true]
  ] as const)(
    'settles the original turn through %s Handoff; fail configuration=%s',
    async (framework, fail) => {
      const storageRoot = await mkdtemp(join(tmpdir(), 'approved-handoff-outcome-'))
      initDataRoot(storageRoot)
      const client = createProjectDbClient(storageRoot)
      await migrateApplicationDatabase(client)
      const repository = new SessionRepository(storageRoot, { hasLiveRuntimeSession: () => true })
      const persistence = new SessionPersistenceCoordinator(
        repository,
        new ManagedFileIndexRepository(
          () => Promise.resolve(client),
          storageRoot,
          new ManagedFileVersionService({ storageRoot, getClient: () => Promise.resolve(client) }),
          new UploadRepository(storageRoot, { getClient: () => Promise.resolve(client) })
        )
      )
      const owner = new RuntimeSessionOwner({
        loadSession: ({ projectId, sessionId }) => repository.loadSession(projectId, sessionId),
        mutateSession: (scope, mutate) => persistence.mutateRuntimeSession(scope, mutate),
        finalizeArtifacts: async () => []
      })
      const process = new ProviderProcess()
      const started = deferred()
      const cancelled = deferred()
      let promptCalls = 0
      const pendingEntered = deferred()
      const pendingRelease = deferred()
      let pendingPrompt: Promise<unknown> | undefined
      let pendingError: unknown
      acp
        .agent({ name: 'handoff-fixture' })
        .onRequest(acp.methods.agent.initialize, () => ({
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
          authMethods: []
        }))
        .onRequest(acp.methods.agent.session.new, () => ({ sessionId: context.sessionId }))
        .onRequest(acp.methods.agent.session.prompt, async () => {
          promptCalls += 1
          started.resolve()
          await cancelled.promise
          return { stopReason: promptCalls === 1 ? 'cancelled' : 'end_turn' }
        })
        .onNotification(acp.methods.agent.session.cancel, () => cancelled.resolve())
        .connect(
          acp.ndJsonStream(
            Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
            Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
          )
        )
      const runtime = new AcpRuntimeCoordinator(
        (callbacks) =>
          new AcpRuntime({
            appVersion: 'test',
            defaultCwd: '/workspace',
            framework: opencodeFramework,
            spawnAgent: () => process as unknown as ChildProcessWithoutNullStreams,
            runtimeSessions: owner,
            callbacks: {
              ...callbacks,
              onEvent: (event) => {
                owner.accept(event)
                callbacks.onEvent?.(event)
              }
            }
          })
      )
      try {
        await runtime.createSession({ cwd: '/workspace', projectId: 'project-1' })
        const messages = [
          {
            id: 'original-prompt',
            role: 'user' as const,
            content: 'Original task',
            status: 'complete' as const,
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
        const graph = createLinearConversationGraph({
          sessionId: context.sessionId,
          messages,
          frameworkId: 'opencode',
          createdAt: 1,
          updatedAt: 1
        })
        await repository.saveSession(
          materializeSessionConversationGraph({
            id: context.sessionId,
            projectId: 'project-1',
            title: 'Handoff',
            cwd: '/workspace',
            status: 'running',
            activeRun: { promptMessageId: 'original-prompt', startedAt: 1 },
            messages,
            conversationGraph: graph,
            createdAt: 1,
            updatedAt: 1
          })
        )
        const request = runtime.sendPrompt({
          sessionId: context.sessionId,
          text: 'Original task',
          provenanceContext: {
            promptMessageId: 'original-prompt',
            agentFrameId: graph.rootFrameId,
            messageBranchId: graph.frames[0].activeBranchId,
            runtimeSegmentId: graph.runtimeSegments[0].id
          }
        })
        await Promise.race([
          started.promise,
          request.then(() => {
            throw new Error('Prompt ended before provider start')
          })
        ])
        const continuation = vi.fn((request: import('../../shared/acp').AcpPromptRequest) =>
          runtime.startContinuation(request)
        )
        let shouldFail = fail
        const failConfiguration = vi.fn(async () => {
          const stopped = await repository.loadSession('project-1', context.sessionId)
          expect(stopped?.messages[0].turnOutcome?.kind).toBe(
            fail && !shouldFail ? 'failed' : 'cancelled'
          )
          expect(stopped?.runtimeSessionAdmissions).toHaveLength(1)
          if (shouldFail) {
            pendingPrompt = runtime
              .sendPromptObserved(
                {
                  sessionId: context.sessionId,
                  text: 'Unadmitted pending attempt',
                  provenanceContext: {
                    promptMessageId: 'original-prompt',
                    agentFrameId: graph.rootFrameId,
                    messageBranchId: graph.frames[0].activeBranchId,
                    runtimeSegmentId: graph.runtimeSegments[0].id
                  }
                },
                () => undefined,
                async () => {
                  pendingEntered.resolve()
                  await pendingRelease.promise
                  throw new Error('Preparation rejected before admission')
                }
              )
              .catch((error: unknown) => {
                pendingError = error
              })
            await pendingEntered.promise
            throw new Error('configuration unavailable')
          }
          return { contextReset: true }
        })
        const adapter =
          framework === 'opencode'
            ? createOpenCodeImmediateHandoffRuntime({
                runtime: {
                  getSessionFramework: () => 'opencode',
                  capturePromptForHandoff: (id) => runtime.capturePromptForHandoff(id),
                  cancelPrompt: async ({ sessionId }) => {
                    await runtime.stopPromptForHandoff(sessionId)
                    return runtime.getState()
                  },
                  waitForPromptOwnershipRelease: (id) => runtime.waitForPromptOwnershipRelease(id),
                  switchSpecialist: failConfiguration,
                  startContinuation: continuation
                },
                resolveSpecialistId: () => 'approved-specialist',
                reportHandoffFailure: async () => undefined
              })
            : createClaudeCodeCompletionGateRuntime({
                sessionFramework: () => 'claude-code',
                cancelPrompt: ({ sessionId }) => runtime.stopPromptForHandoff(sessionId),
                waitForPromptOwnershipRelease: (id) => runtime.waitForPromptOwnershipRelease(id),
                resolveSpecialistId: () => 'approved-specialist',
                resolveSwitchReadBack: async () => ({
                  status: 'approved',
                  operation: 'switch',
                  binding: {
                    sessionId: context.sessionId,
                    specialistId: 'approved-specialist',
                    targetName: 'Specialist'
                  }
                }),
                prepareReplayContext: async () => {
                  await failConfiguration()
                },
                discardReplayContext: async () => undefined,
                switchSpecialist: async () => ({ contextReset: true }),
                createContinuationRequest: async () => ({
                  sessionId: context.sessionId,
                  text: 'Continue',
                  provenanceContext: {
                    promptMessageId: 'original-prompt',
                    agentFrameId: graph.rootFrameId,
                    messageBranchId: graph.frames[0].activeBranchId,
                    runtimeSegmentId: graph.runtimeSegments[0].id
                  }
                }),
                sendAppContinuation: continuation
              })
        const composed = withApprovedHandoffOutcome(runtime, adapter)
        const lifecycle = new CompletionHandoffLifecycle(
          new FileCompletionHandoffRepository(storageRoot),
          composed
        )
        const completion = new CompletionGateCoordinator(composed, lifecycle)
        await completion.arm(context, 'Specialist')
        await completion.complete(completion.claimCompletion(context, handoff.envelope), context)
        await request
        if (fail) {
          const failed = await repository.loadSession('project-1', context.sessionId)
          expect(failed?.messages[0].turnOutcome).toMatchObject({
            kind: 'failed',
            error: 'The approved specialist could not continue the current task.'
          })
          expect(failed?.runtimeSessionAdmissions).toHaveLength(1)
          expect(failed?.resumeRecovery).toBeUndefined()
          expect(failed?.activeRun).toBeUndefined()
          expect(continuation).not.toHaveBeenCalled()
          expect(promptCalls).toBe(1)
          pendingRelease.resolve()
          await pendingPrompt
          expect(pendingError).toBeInstanceOf(Error)
          expect((pendingError as Error).message).toBe('Preparation rejected before admission')
          runtime.setPromptAdmissionGuard(async (sessionId) => {
            if (!(await lifecycle.canStartUserPrompt(sessionId)))
              throw new Error('Handoff must finish first')
          })
          await expect(
            runtime.sendPrompt({ sessionId: context.sessionId, text: 'Rejected new send' })
          ).rejects.toThrow('Handoff must finish first')
          shouldFail = false
          const retried = await lifecycle.retry(context)
          expect(retried.stage).toBe('continued')
        }
        await runtime.waitForPromptOwnershipRelease(context.sessionId)
        const continued = await repository.loadSession('project-1', context.sessionId)
        expect(continued?.messages[0].turnOutcome?.kind).toBe('completed')
        expect(continued?.runtimeSessionAdmissions).toHaveLength(framework === 'opencode' ? 1 : 2)
        expect(promptCalls).toBe(2)
      } finally {
        pendingRelease.resolve()
        await pendingPrompt
        await runtime.disconnect()
        await client.$disconnect()
        await rm(storageRoot, { recursive: true, force: true })
      }
    }
  )
})
