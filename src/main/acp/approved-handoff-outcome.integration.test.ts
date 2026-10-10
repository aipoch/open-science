import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: true } }))

import { applySessionConversationCommands } from '../../shared/session-conversation-command'
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
  CompletionGateRuntimeRegistry,
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
    ['opencode', false, false, false, false],
    ['opencode', false, true, false, false],
    ['opencode', false, true, true, false],
    ['opencode', false, true, true, true],
    ['opencode', true, false, false, false],
    ['claude-code', false, false, false, false],
    ['claude-code', true, false, false, false]
  ] as const)(
    'settles the original turn through %s Handoff; fail configuration=%s; repeated=%s; disabled owned Skill=%s; resume failure=%s',
    async (framework, fail, repeat, disabledOwnedSkill, failResume) => {
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
      const processes: ProviderProcess[] = []
      const providerPrompts: string[] = []
      const resumedProviderIds: string[] = []
      const backendSkillScopes: string[][] = []
      const started = deferred()
      const cancelled = deferred()
      const secondStarted = deferred()
      const secondCancelled = deferred()
      let promptCalls = 0
      const pendingEntered = deferred()
      const pendingRelease = deferred()
      let pendingPrompt: Promise<unknown> | undefined
      let pendingError: unknown
      const spawn = (): ChildProcessWithoutNullStreams => {
        const process = new ProviderProcess()
        processes.push(process)
        acp
          .agent({ name: 'handoff-fixture' })
          .onRequest(acp.methods.agent.initialize, () => ({
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: false,
              sessionCapabilities: { close: {}, resume: {} }
            },
            authMethods: []
          }))
          .onRequest(acp.methods.agent.session.new, () => ({ sessionId: context.sessionId }))
          .onRequest(acp.methods.agent.session.resume, (ctx) => {
            resumedProviderIds.push(ctx.params.sessionId)
            if (failResume && resumedProviderIds.length === 2)
              throw new Error('Temporary provider resume failure')
            return {}
          })
          .onRequest(acp.methods.agent.session.close, () => ({}))
          .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
            providerPrompts.push(
              ctx.params.prompt.map((part) => (part.type === 'text' ? part.text : '')).join('')
            )
            promptCalls += 1
            started.resolve()
            if (repeat && promptCalls === 3) {
              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: ctx.params.sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Specialist working' }
                }
              })
              secondStarted.resolve()
              await secondCancelled.promise
              return { stopReason: 'cancelled' }
            }
            await cancelled.promise
            return { stopReason: promptCalls === 1 ? 'cancelled' : 'end_turn' }
          })
          .onNotification(acp.methods.agent.session.cancel, () => {
            cancelled.resolve()
            if (promptCalls === 3) secondCancelled.resolve()
          })
          .connect(
            acp.ndJsonStream(
              Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
              Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
            )
          )
        return process as unknown as ChildProcessWithoutNullStreams
      }
      const runtime = new AcpRuntimeCoordinator(
        (callbacks) =>
          new AcpRuntime({
            appVersion: 'test',
            defaultCwd: '/workspace',
            framework: opencodeFramework,
            spawnAgent: spawn,
            ...(repeat
              ? {
                  resolveBackend: async ({ forcedSkillIds }) => {
                    backendSkillScopes.push([...forcedSkillIds])
                    return {
                      framework: { ...opencodeFramework, spawn },
                      executablePath: '/fixture/opencode',
                      env: {}
                    }
                  }
                }
              : {}),
            ...(repeat
              ? {
                  resolveSpecialistIdentity: async () => ({
                    append: 'Approved Specialist',
                    prefix: 'Approved Specialist'
                  }),
                  resolveSpecialistSkills: async () => ({
                    kind: 'specialist' as const,
                    skillIds: ['disabled-skill'],
                    frameworkNames: ['Disabled Skill'],
                    missingSkillIds: []
                  }),
                  skills: {
                    needForceLoad: async (ids: string[]) =>
                      disabledOwnedSkill && promptCalls === 2 ? ids : [],
                    namesForIds: async (ids: string[]) => ids
                  }
                }
              : {}),
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
        let approvedBinding: string | undefined = 'approved-specialist'
        const failConfiguration = vi.fn(async () => {
          const stopped = await repository.loadSession('project-1', context.sessionId)
          expect(
            stopped?.messages.find(
              ({ id }) => id === (repeat && promptCalls === 3 ? 'second-prompt' : 'original-prompt')
            )?.turnOutcome?.kind
          ).toBe(
            (fail && !shouldFail) || (failResume && resumedProviderIds.length >= 3)
              ? 'failed'
              : 'cancelled'
          )
          expect(stopped?.runtimeSessionAdmissions).toHaveLength(
            repeat && promptCalls === 3 ? 2 : 1
          )
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
          if (framework === 'opencode')
            return runtime.switchSpecialist(context.sessionId, approvedBinding)
          return { contextReset: true }
        })
        const adapter =
          framework === 'opencode'
            ? createOpenCodeImmediateHandoffRuntime({
                runtime: {
                  getSessionFramework: (sessionId) => runtime.getSessionFramework(sessionId),
                  capturePromptForHandoff: (id) => runtime.capturePromptForHandoff(id),
                  cancelPrompt: async ({ sessionId }) => {
                    await runtime.stopPromptForHandoff(sessionId)
                    return runtime.getState()
                  },
                  waitForPromptOwnershipRelease: (id) => runtime.waitForPromptOwnershipRelease(id),
                  switchSpecialist: failConfiguration,
                  startContinuation: continuation
                },
                resolveSpecialistId: () => approvedBinding,
                reportHandoffFailure: async () => undefined
              })
            : createClaudeCodeCompletionGateRuntime({
                sessionFramework: () => 'claude-code',
                cancelPrompt: ({ sessionId }) => runtime.stopPromptForHandoff(sessionId),
                waitForPromptOwnershipRelease: (id) => runtime.waitForPromptOwnershipRelease(id),
                resolveSpecialistId: () => approvedBinding,
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
        const composed = new CompletionGateRuntimeRegistry()
        composed.register(withApprovedHandoffOutcome(runtime, adapter))
        const lifecycle = new CompletionHandoffLifecycle(
          new FileCompletionHandoffRepository(storageRoot),
          composed
        )
        const completion = new CompletionGateCoordinator(composed, lifecycle)
        await completion.arm(context, 'Specialist')
        await completion.complete(completion.claimCompletion(context, handoff.envelope), context)
        await request
        if (repeat) {
          await runtime.waitForPromptOwnershipRelease(context.sessionId)
          await persistence.mutateRuntimeSession(
            { projectId: 'project-1', sessionId: context.sessionId },
            (session) =>
              applySessionConversationCommands(session, [
                {
                  id: 'second-message-command',
                  timestamp: Date.now(),
                  kind: 'append-user',
                  branchId: graph.frames[0].activeBranchId!,
                  parentMessageId: session.conversationGraph!.branches[0].headMessageId,
                  message: { ...messages[0], id: 'second-prompt', content: 'Return to Main Agent' }
                },
                {
                  id: 'second-run-command',
                  timestamp: Date.now(),
                  kind: 'start-run',
                  run: { promptMessageId: 'second-prompt', startedAt: Date.now() }
                }
              ])
          )
          const secondRequest = runtime.sendPrompt({
            sessionId: context.sessionId,
            text: 'Return to Main Agent',
            provenanceContext: {
              promptMessageId: 'second-prompt',
              agentFrameId: graph.rootFrameId,
              messageBranchId: graph.frames[0].activeBranchId,
              runtimeSegmentId: graph.runtimeSegments[0].id
            }
          })
          void secondRequest.catch(() => undefined)
          await Promise.race([
            secondStarted.promise,
            secondRequest.then(() => {
              throw new Error('Second prompt ended before provider start')
            })
          ])
          const nextContext = { ...context, turnId: 'second-turn', toolInvocationId: 'tool-2' }
          approvedBinding = undefined
          await completion.arm(nextContext, null)
          await completion.complete(
            completion.claimCompletion(nextContext, handoff.envelope),
            nextContext
          )
          if (failResume) {
            expect((await lifecycle.getEvents(context.sessionId)).at(-1)).toMatchObject({
              phase: 'failed',
              target: null,
              failure: { retryFrom: 'reconfiguring' }
            })
            expect(promptCalls).toBe(3)
            expect(continuation).toHaveBeenCalledTimes(1)
            expect(approvedBinding).toBeUndefined()
            await lifecycle.retry(nextContext)
          }
          expect((await lifecycle.getEvents(context.sessionId)).at(-1)?.phase).toBe('continued')
          await secondRequest.catch(() => undefined)
        }
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
        expect(continued?.runtimeSessionAdmissions).toHaveLength(
          repeat ? 2 : framework === 'opencode' ? 1 : 2
        )
        expect(promptCalls).toBe(repeat ? 4 : 2)
        if (repeat) {
          expect(
            continued?.messages.filter(({ role }) => role === 'user').map(({ id }) => id)
          ).toEqual(['original-prompt', 'second-prompt'])
          expect(
            continued?.messages.find(({ id }) => id === 'second-prompt')?.turnOutcome?.kind
          ).toBe('completed')
          expect(providerPrompts.at(-1)).toContain('Current agent: Main Agent')
          expect(providerPrompts.at(-1)).not.toContain('Approved Specialist')
          if (disabledOwnedSkill) {
            expect(processes.length).toBeGreaterThanOrEqual(3)
            expect(backendSkillScopes).toContainEqual(['disabled-skill'])
            expect(backendSkillScopes.at(-1)).toEqual([])
            expect(resumedProviderIds).toEqual(Array(failResume ? 3 : 2).fill(context.sessionId))
          }
        }
      } finally {
        pendingRelease.resolve()
        secondCancelled.resolve()
        await pendingPrompt
        await runtime.disconnect()
        await client.$disconnect()
        await rm(storageRoot, { recursive: true, force: true })
      }
    }
  )
})
