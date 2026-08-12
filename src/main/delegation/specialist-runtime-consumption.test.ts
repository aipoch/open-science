import type { PromptResponse } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import { opencodeFramework } from '../agent-framework'
import { CODEX_ACP_VERSION, CODEX_VERSION } from '../settings/managed-codex'
import type { AcpDelegateRuntime } from './acp-execution'
import { createClaudeCodeDelegateExecution } from './claude-code-execution'
import {
  createCodexDelegateExecution,
  type PreparedCodexDelegateExecution
} from './codex-execution'
import type { DelegateExecution, DelegateExecutionInput } from './execution-port'
import {
  createOpenCodeDelegateExecution,
  type PreparedOpenCodeDelegateExecution
} from './opencode-execution'

type CreateSessionRequest = Parameters<AcpDelegateRuntime['createSession']>[0]

const input = (attemptId: string, profile?: string): DelegateExecutionInput => ({
  session: { projectId: 'project-1', sessionId: 'session-1' },
  frameId: `frame-${attemptId}`,
  attemptId,
  runtimeSegmentId: `segment-${attemptId}`,
  task: `task-${attemptId}`,
  inputs: [],
  ...(profile ? { profile } : {}),
  continuation: false
})

const runtimeFor = (
  attemptId: string,
  requests: Array<{ attemptId: string; request: CreateSessionRequest }>
): AcpDelegateRuntime => {
  let finish!: (response: PromptResponse) => void
  const completion = new Promise<PromptResponse>((resolve) => {
    finish = resolve
  })
  return {
    createSession: async (request) => {
      requests.push({ attemptId, request })
      return { sessionId: `provider-${attemptId}` }
    },
    sendAppContinuation: async () => completion,
    cancelPrompt: async () => finish({ stopReason: 'cancelled' }),
    setPermissionProfile: async () => undefined,
    respondToPermission: async () => undefined,
    deleteSession: async () => undefined,
    shutdownForQuit: async () => ({ reaped: true })
  }
}

const openCodeModelConfig = (
  storageRoot: string
): ReturnType<typeof opencodeFramework.prepareModelConfig> =>
  opencodeFramework.prepareModelConfig(
    {
      type: 'custom',
      baseUrl: 'https://provider.example/v1',
      model: 'certification-model',
      key: 'certification-key',
      apiEndpoints: ['openai']
    },
    { storageRoot, executablePath: '/bin/opencode' }
  )

type Harness = Readonly<{
  execution: DelegateExecution
  requests: Array<{ attemptId: string; request: CreateSessionRequest }>
}>

const factories: ReadonlyArray<{
  framework: 'claude-code' | 'opencode' | 'codex'
  create(): Harness
}> = [
  {
    framework: 'claude-code',
    create() {
      const requests: Harness['requests'] = []
      return {
        requests,
        execution: createClaudeCodeDelegateExecution({
          capacity: 2,
          prepare: (delegateInput) => ({
            executionId: delegateInput.attemptId,
            provenance: {
              projectId: delegateInput.session.projectId,
              sessionId: delegateInput.session.sessionId,
              agentFrameId: delegateInput.frameId,
              runtimeSegmentId: delegateInput.runtimeSegmentId
            },
            workspace: { cwd: `/workspace/${delegateInput.frameId}` },
            runtimeHome: `/runtime/${delegateInput.attemptId}`,
            frameworkId: 'claude-code',
            capability: { revoke: async () => undefined }
          }),
          createRuntime: (scope) => runtimeFor(scope.executionId, requests)
        })
      }
    }
  },
  {
    framework: 'opencode',
    create() {
      const requests: Harness['requests'] = []
      return {
        requests,
        execution: createOpenCodeDelegateExecution({
          capacity: 2,
          certificationConfig: () => openCodeModelConfig('/runtime/admission'),
          prepare: (delegateInput): PreparedOpenCodeDelegateExecution => ({
            executionId: delegateInput.attemptId,
            provenance: {
              projectId: delegateInput.session.projectId,
              sessionId: delegateInput.session.sessionId,
              agentFrameId: delegateInput.frameId,
              runtimeSegmentId: delegateInput.runtimeSegmentId
            },
            workspace: { cwd: `/workspace/${delegateInput.frameId}` },
            runtimeHome: `/runtime/${delegateInput.attemptId}`,
            frameworkId: 'opencode',
            modelConfig: openCodeModelConfig(`/runtime/${delegateInput.attemptId}`),
            capability: { revoke: async () => undefined }
          }),
          createRuntime: (scope) => runtimeFor(scope.executionId, requests)
        })
      }
    }
  },
  {
    framework: 'codex',
    create() {
      const requests: Harness['requests'] = []
      const codex = createCodexDelegateExecution({
        capacity: 2,
        runtime: { nativeVersion: CODEX_VERSION, adapterVersion: CODEX_ACP_VERSION },
        framework: {
          spawn: () => ({ kill: vi.fn() }) as unknown as ChildProcessWithoutNullStreams
        },
        prepare: (delegateInput): PreparedCodexDelegateExecution => {
          const runtimeHome = `/runtime/${delegateInput.attemptId}`
          return {
            executionId: delegateInput.attemptId,
            provenance: {
              projectId: delegateInput.session.projectId,
              sessionId: delegateInput.session.sessionId,
              agentFrameId: delegateInput.frameId,
              runtimeSegmentId: delegateInput.runtimeSegmentId
            },
            workspace: { cwd: `/workspace/${delegateInput.frameId}` },
            runtimeHome,
            capability: { revoke: async () => undefined },
            spawn: {
              executablePath: '/bin/codex-acp',
              args: [],
              env: {
                HOME: runtimeHome,
                CODEX_HOME: runtimeHome,
                CODEX_CONFIG: JSON.stringify({
                  features: { multi_agent: false, multi_agent_v2: false }
                })
              }
            }
          }
        },
        createRuntime: (scope) => runtimeFor(scope.executionId, requests)
      })
      return { requests, execution: codex.execution }
    }
  }
]

describe.each(factories)('$framework delegated Specialist runtime consumption', ({ create }) => {
  it('passes the resolved stable Specialist id to ACP createSession and omits it for Main', async () => {
    const { execution, requests } = create()
    const reservation = await execution.reserve(2)
    const specialist = execution.run(
      input('specialist', 'specialist-stable-id'),
      reservation.slotIds[0]
    )
    const main = execution.run(input('main'), reservation.slotIds[1])

    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests.find(({ attemptId }) => attemptId === 'specialist')?.request).toMatchObject({
      specialistId: 'specialist-stable-id'
    })
    expect(requests.find(({ attemptId }) => attemptId === 'main')?.request).not.toHaveProperty(
      'specialistId'
    )

    await Promise.all([specialist.cancel(), main.cancel()])
    await Promise.all([specialist.completion, main.completion])
  })
})
