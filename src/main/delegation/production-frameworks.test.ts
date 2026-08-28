import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import { claudeCodeFramework } from '../agent-framework'
import { CODEX_ACP_VERSION, CODEX_VERSION } from '../settings/managed-codex'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { AgentFrameworkId } from '../../shared/settings'
import { DelegateMessagePreAcceptanceError, type DelegateExecutionInput } from './execution-port'
import { createProductionDelegatedFrameworks } from './production-frameworks'
import { productionDelegatedWorkFrameworks } from './production-readiness'

const session = (frameworkId: AgentFrameworkId): PersistedChatSession => ({
  id: `session-${frameworkId}`,
  projectId: 'project-1',
  title: frameworkId,
  cwd: '/root',
  status: 'idle',
  agentFrameworkId: frameworkId,
  messages: [],
  filesRevision: 1,
  createdAt: 1,
  updatedAt: 1
})

const input = (frameworkId: AgentFrameworkId): DelegateExecutionInput => ({
  session: { projectId: 'project-1', sessionId: `session-${frameworkId}` },
  frameId: `frame-${frameworkId}`,
  attemptId: `attempt-${frameworkId}`,
  runtimeSegmentId: `runtime-${frameworkId}`,
  task: 'inspect',
  inputs: [],
  workspaceCwd: `/workspaces/frame-${frameworkId}`,
  continuation: false
})

const safeOpenCodeConfig = {
  env: {
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: { task: 'deny' },
      agent: {
        general: { disable: true },
        explore: { disable: true },
        scout: { disable: true }
      }
    })
  },
  configFiles: [
    {
      path: '/runtime/opencode.json',
      content: JSON.stringify({
        permission: { task: 'deny' },
        agent: {
          general: { disable: true },
          explore: { disable: true },
          scout: { disable: true }
        }
      })
    }
  ]
}

const deferred = <Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

describe('production delegated framework factory composition', () => {
  it('publishes support only for frameworks present in the production factory composer', () => {
    expect(productionDelegatedWorkFrameworks()).toEqual([
      'claude-code',
      'opencode',
      'codex',
      'codebuddy'
    ])
  })

  it('selects the certified Claude Code, OpenCode, and Codex production factories', async () => {
    const prepared: AgentFrameworkId[] = []
    const runtimes: AgentFrameworkId[] = []
    const initialPrompts = new Map<AgentFrameworkId, ReturnType<typeof deferred<PromptResponse>>>()
    const frameworks = createProductionDelegatedFrameworks({
      capacity: 3,
      async certify(durableSession) {
        const frameworkId = durableSession.agentFrameworkId!
        return {
          frameworkId,
          assertProviderAvailable: async () => undefined,
          ...(frameworkId === 'codex'
            ? {
                codexRuntime: {
                  nativeVersion: CODEX_VERSION,
                  adapterVersion: CODEX_ACP_VERSION
                },
                codexFramework: {
                  spawn: () => ({ kill: vi.fn() }) as unknown as ChildProcessWithoutNullStreams
                }
              }
            : {}),
          ...(frameworkId === 'codebuddy'
            ? {
                codebuddyFramework: {
                  spawn: () => ({ kill: vi.fn() }) as unknown as ChildProcessWithoutNullStreams
                }
              }
            : {}),
          prepare: async (executionInput: DelegateExecutionInput) => {
            prepared.push(frameworkId)
            const runtimeHome = `/runtime/${executionInput.attemptId}`
            const base = {
              executionId: executionInput.attemptId,
              provenance: {
                projectId: executionInput.session.projectId,
                sessionId: executionInput.session.sessionId,
                agentFrameId: executionInput.frameId,
                runtimeSegmentId: executionInput.runtimeSegmentId
              },
              workspace: { cwd: executionInput.workspaceCwd! },
              runtimeHome,
              frameworkId,
              capability: { revoke: async () => undefined }
            }
            return frameworkId === 'claude-code'
              ? {
                  ...base,
                  sessionSetup: claudeCodeFramework.buildSessionSetup({
                    systemPromptAppends: []
                  })
                }
              : frameworkId === 'opencode'
                ? { ...base, modelConfig: safeOpenCodeConfig }
                : frameworkId === 'codex'
                  ? {
                      ...base,
                      spawn: {
                        executablePath: '/codex-acp.js',
                        args: [],
                        env: {
                          HOME: runtimeHome,
                          CODEX_HOME: runtimeHome,
                          CODEX_CONFIG: JSON.stringify({
                            features: { multi_agent: false, multi_agent_v2: false }
                          })
                        } as Record<string, string>
                      }
                    }
                  : {
                      ...base,
                      spawn: {
                        executablePath: '/codebuddy',
                        args: ['--tools', 'Read,Write,Edit,Glob,Grep,Bash'],
                        env: {
                          CODEBUDDY_DISABLE_FORK_SUBAGENT: '1',
                          CODEBUDDY_DISABLE_BACKGROUND_TASKS: '1',
                          CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1'
                        } as Record<string, string>
                      }
                    }
          },
          createRuntime: (_scope, callbacks) => {
            runtimes.push(frameworkId)
            const providerSessionId = `provider-${frameworkId}`
            const initial = deferred<PromptResponse>()
            initialPrompts.set(frameworkId, initial)
            let promptCount = 0
            return {
              createSession: async () => ({ sessionId: providerSessionId }),
              sendAppContinuation: async () => {
                promptCount += 1
                if (promptCount <= 2) callbacks.onProviderPromptAccepted(providerSessionId)
                if (promptCount === 1) return initial.promise
                if (promptCount <= 3) return { stopReason: 'end_turn' }
                throw new DelegateMessagePreAcceptanceError(
                  `${frameworkId} pre-accept transport failure`
                )
              },
              cancelPrompt: async () => undefined,
              setPermissionProfile: async () => undefined,
              respondToPermission: async () => undefined,
              deleteSession: async () => undefined,
              shutdownForQuit: async () => ({ reaped: true })
            }
          }
        }
      }
    })

    for (const frameworkId of ['claude-code', 'opencode', 'codex', 'codebuddy'] as const) {
      const selected = await frameworks.forSession(session(frameworkId))
      await selected.assertAvailable()
      const reservation = await selected.execution.reserve(1)
      const running = selected.execution.run(input(frameworkId), reservation.slotIds[0])
      await running.accepted
      const acceptedDelivery = running.sendMessage('provider accepted evidence')
      const completedDelivery = running.sendMessage('successful completion fallback evidence')
      const rejectedDelivery = running.sendMessage('pre-accept failure evidence')
      initialPrompts.get(frameworkId)!.resolve({ stopReason: 'end_turn' })
      await expect(acceptedDelivery).resolves.toBe('provider_prompt_accepted')
      await expect(completedDelivery).resolves.toBe('provider_prompt_completed')
      await expect(rejectedDelivery).rejects.toThrow(`${frameworkId} pre-accept transport failure`)
      await expect(running.completion).rejects.toThrow(
        `${frameworkId} pre-accept transport failure`
      )
    }

    expect(prepared).toEqual(['claude-code', 'opencode', 'codex', 'codebuddy'])
    expect(runtimes).toEqual(['claude-code', 'opencode', 'codex', 'codebuddy'])
  })

  it('rejects an unsafe fresh framework audit before workspace preparation or runtime creation', async () => {
    const prepare = vi.fn()
    const createRuntime = vi.fn()
    const frameworks = createProductionDelegatedFrameworks({
      capacity: 1,
      certify: async () => ({
        frameworkId: 'opencode',
        assertProviderAvailable: async () => {
          throw new Error('OpenCode native delegation is not disabled')
        },
        prepare,
        createRuntime
      })
    })

    const selected = await frameworks.forSession(session('opencode'))
    await expect(selected.assertAvailable()).rejects.toThrow(
      'OpenCode native delegation is not disabled'
    )
    expect(prepare).not.toHaveBeenCalled()
    expect(createRuntime).not.toHaveBeenCalled()
  })

  it('rejects unsafe Codex launch configuration during fresh pre-admission certification', async () => {
    const prepare = vi.fn()
    const createRuntime = vi.fn()
    const frameworks = createProductionDelegatedFrameworks({
      capacity: 1,
      certify: async () => ({
        frameworkId: 'codex',
        codexRuntime: {
          nativeVersion: CODEX_VERSION,
          adapterVersion: CODEX_ACP_VERSION
        },
        assertProviderAvailable: async () => {
          throw new Error('Codex native multi-agent features must be disabled')
        },
        prepare,
        createRuntime
      })
    })

    const selected = await frameworks.forSession(session('codex'))
    await expect(selected.assertAvailable()).rejects.toThrow(
      'native multi-agent features must be disabled'
    )
    expect(prepare).not.toHaveBeenCalled()
    expect(createRuntime).not.toHaveBeenCalled()
  })
})
