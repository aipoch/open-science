import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { TaskAgentPort } from '../tasks/task-runner'
import { createAcpTaskAgentPort } from './task-agent-port'

describe('ACP Task Agent port', () => {
  it('exposes only the Task execution capabilities', () => {
    expectTypeOf<keyof TaskAgentPort>().toEqualTypeOf<
      | 'withSessionAvailable'
      | 'listAttachedSessionIds'
      | 'createSession'
      | 'resumeSession'
      | 'setPermissionProfile'
      | 'prompt'
      | 'cancelPrompt'
    >()
  })

  it('translates only the Task execution contract to ACP session operations', async () => {
    const create = vi.fn(async () => ({
      sessionId: 'session-created',
      cwd: '/workspace/created',
      frameworkId: 'codex' as const,
      backendId: 'codex:shared'
    }))
    const runtime = {
      getSnapshot: vi.fn(() => ({ sessionIds: ['session-attached'] })),
      resumeSession: vi.fn(async () => ({
        sessionId: 'session-resumed',
        cwd: '/workspace/resumed',
        frameworkId: 'opencode' as const,
        backendId: 'opencode:shared',
        contextReset: true
      })),
      setPermissionProfile: vi.fn(async () => undefined),
      sendPrompt: vi.fn(async () => undefined),
      sendPromptObserved: vi.fn(async () => undefined),
      cancelPrompt: vi.fn(async () => undefined)
    }
    const withSessionAvailable = vi.fn()
    const resolveSessionAgentTarget = vi.fn(async (configuration) =>
      configuration ? ({ frameworkId: 'opencode' as const, ...configuration } as const) : undefined
    )
    const defaultAgentTarget = {
      frameworkId: 'codex' as const,
      providerId: 'provider-default',
      model: 'model-default',
      reasoningEffort: 'medium' as const
    }
    const resolveDefaultSessionAgentTarget = vi.fn(async () => defaultAgentTarget)
    const port = createAcpTaskAgentPort(
      runtime,
      { create },
      undefined,
      {
        withSessionAvailable: async <Result>(
          projectId: string,
          sessionId: string,
          operation: () => Promise<Result>
        ) => {
          withSessionAvailable(projectId, sessionId, operation)
          return operation()
        }
      },
      resolveSessionAgentTarget,
      resolveDefaultSessionAgentTarget
    )

    const admitted = vi.fn(async () => 'admitted')
    await expect(port.withSessionAvailable('project-1', 'session-stable', admitted)).resolves.toBe(
      'admitted'
    )
    await expect(port.listAttachedSessionIds()).resolves.toEqual(['session-attached'])
    await expect(
      port.createSession({
        projectId: 'project-1',
        permissionProfile: 'auto',
        cwd: '/workspace/external',
        specialistId: 'specialist-1'
      })
    ).resolves.toMatchObject({
      sessionId: 'session-created',
      frameworkId: 'codex',
      backendId: 'codex:shared',
      agentConfiguration: {
        providerId: 'provider-default',
        model: 'model-default',
        reasoningEffort: 'medium'
      }
    })
    await expect(
      port.resumeSession({
        sessionId: 'session-stable',
        cwd: '/workspace/stable',
        projectId: 'project-1',
        permissionProfile: 'ask',
        previousFrameworkId: 'codex',
        previousBackendId: 'codex:shared',
        specialistId: 'specialist-1',
        agentConfiguration: {
          providerId: 'provider-1',
          model: 'model-1',
          reasoningEffort: 'high'
        }
      })
    ).resolves.toMatchObject({
      sessionId: 'session-resumed',
      contextReset: true
    })
    await port.setPermissionProfile('session-stable', 'full')
    await port.prompt({
      sessionId: 'session-stable',
      promptMessageId: 'persisted-prompt',
      text: 'Continue the research.',
      turnIntent: 'plan-first',
      skillIds: ['literature-review'],
      historyPreamble: 'Previous conversation.',
      contextReset: true,
      resumeFallback: { historyPreamble: 'Fallback conversation.' }
    })
    await port.cancelPrompt('session-stable')

    expect(create).toHaveBeenCalledWith({
      projectId: 'project-1',
      permissionProfile: 'auto',
      cwd: '/workspace/external',
      specialistId: 'specialist-1',
      agentTarget: defaultAgentTarget
    })
    expect(resolveDefaultSessionAgentTarget).toHaveBeenCalledOnce()
    expect(withSessionAvailable).toHaveBeenCalledWith('project-1', 'session-stable', admitted)
    expect(resolveSessionAgentTarget).toHaveBeenCalledWith({
      providerId: 'provider-1',
      model: 'model-1',
      reasoningEffort: 'high'
    })
    expect(runtime.resumeSession).toHaveBeenCalledWith({
      sessionId: 'session-stable',
      cwd: '/workspace/stable',
      projectId: 'project-1',
      permissionProfile: 'ask',
      previousFrameworkId: 'codex',
      previousBackendId: 'codex:shared',
      specialistId: 'specialist-1',
      agentTarget: {
        frameworkId: 'opencode',
        providerId: 'provider-1',
        model: 'model-1',
        reasoningEffort: 'high'
      }
    })
    expect(runtime.setPermissionProfile).toHaveBeenCalledWith({
      sessionId: 'session-stable',
      profile: 'full'
    })
    expect(runtime.sendPrompt).toHaveBeenCalledWith({
      sessionId: 'session-stable',
      text: 'Continue the research.',
      provenanceContext: { promptMessageId: 'persisted-prompt' },
      forcedSkillIds: ['literature-review'],
      turnIntent: 'plan-first',
      historyPreamble: 'Previous conversation.',
      contextReset: true,
      resumeFallback: { historyPreamble: 'Fallback conversation.' }
    })
    expect(runtime.cancelPrompt).toHaveBeenCalledWith({ sessionId: 'session-stable' })
  })

  it('keeps Task prompt notification tracking equivalent on success and failure', async () => {
    const prompt = {
      sessionId: 'session-1',
      promptMessageId: 'persisted-prompt',
      text: 'Research this.',
      skillIds: ['literature-review']
    }
    const sendPrompt = vi.fn(async () => undefined)
    const trackedPrompt = { token: 1 }
    const trackPrompt = vi.fn(() => trackedPrompt)
    const untrackPrompt = vi.fn()
    const port = createAcpTaskAgentPort(
      {
        getSnapshot: () => ({ sessionIds: [] }),
        resumeSession: vi.fn(),
        setPermissionProfile: vi.fn(),
        sendPrompt,
        sendPromptObserved: sendPrompt,
        cancelPrompt: vi.fn()
      },
      { create: vi.fn() },
      { trackPrompt, untrackPrompt }
    )

    await port.prompt(prompt)

    expect(trackPrompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      text: 'Research this.',
      provenanceContext: { promptMessageId: 'persisted-prompt' },
      forcedSkillIds: ['literature-review']
    })
    expect(untrackPrompt).not.toHaveBeenCalled()

    const failure = new Error('prompt failed')
    sendPrompt.mockRejectedValueOnce(failure)
    await expect(port.prompt(prompt)).rejects.toBe(failure)
    expect(untrackPrompt).toHaveBeenCalledWith('session-1', trackedPrompt)
  })

  it('forwards provider acceptance through the provider-neutral Task prompt observer', async () => {
    const onProviderPromptAccepted = vi.fn()
    const sendPrompt = vi.fn(async (_request, onAccepted?: () => void) => {
      onAccepted?.()
    })
    const port = createAcpTaskAgentPort(
      {
        getSnapshot: () => ({ sessionIds: [] }),
        resumeSession: vi.fn(),
        setPermissionProfile: vi.fn(),
        sendPrompt,
        sendPromptObserved: sendPrompt,
        cancelPrompt: vi.fn()
      },
      { create: vi.fn() }
    )

    await port.prompt(
      {
        sessionId: 'session-1',
        promptMessageId: 'prompt-1',
        text: 'Research this.'
      },
      { onProviderPromptAccepted }
    )

    expect(onProviderPromptAccepted).toHaveBeenCalledOnce()
  })
})
