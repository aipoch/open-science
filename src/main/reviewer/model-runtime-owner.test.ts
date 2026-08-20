import { describe, expect, it, vi } from 'vitest'

import type { AcpRuntime, AcpRuntimeOptions } from '../acp/runtime'
import type { ResolvedAgentBackend } from '../agent-framework'
import { ReviewerModelRuntimeOwner } from './model-runtime-owner'

describe('ReviewerModelRuntimeOwner', () => {
  it('tracks inherited Reviewer work until its shared-runtime admission is released', async () => {
    const owner = new ReviewerModelRuntimeOwner({
      appVersion: 'test',
      captureModel: async () => ({ model: 'inherited-model' }),
      resolveTarget: vi.fn()
    })

    expect(owner.hasActiveWork()).toBe(false)
    const admission = await owner.admit()

    expect(admission.reviewerAcpRuntime).toBeUndefined()
    expect(owner.hasActiveWork()).toBe(true)

    await admission.release()
    expect(owner.hasActiveWork()).toBe(false)
  })

  it.each([
    {
      path: 'claude-code',
      frameworkId: 'claude-code',
      modelRoute: 'claude-anthropic'
    },
    {
      path: 'opencode',
      frameworkId: 'opencode',
      modelRoute: 'opencode-openai'
    },
    {
      path: 'codex-response',
      frameworkId: 'codex',
      modelRoute: 'codex-responses'
    },
    {
      path: 'codex-response-compatibility',
      frameworkId: 'codex',
      modelRoute: 'codex-responses-compatibility'
    },
    {
      path: 'codex-bridge',
      frameworkId: 'codex',
      modelRoute: 'codex-bridge'
    }
  ] as const)(
    'owns an isolated runtime without rewriting the $path backend',
    async ({ path, frameworkId, modelRoute }) => {
      const shutdownForQuit = vi.fn(async () => ({ reaped: true }))
      const fixedRuntime = {
        buildReviewerSession: vi.fn(),
        disposeReviewerSession: vi.fn(),
        sendPrompt: vi.fn(),
        shutdownForQuit
      } as unknown as AcpRuntime
      let runtimeOptions: AcpRuntimeOptions | undefined
      const target = {
        frameworkId,
        providerId: `${path}-reviewer-provider`,
        model: { kind: 'required' as const, id: `${path}-reviewer-model` },
        reasoningEffort: 'high' as const
      }
      const backend = {
        framework: { id: frameworkId },
        modelRoute,
        executablePath: '/agent',
        env: {},
        contextUsageModel: `${target.model.id}-tokenizer`
      } as ResolvedAgentBackend
      const resolveTarget = vi.fn(async () => backend)
      const owner = new ReviewerModelRuntimeOwner({
        appVersion: 'test',
        captureModel: async () => ({ model: target.model.id, fixedTarget: target }),
        resolveTarget,
        createRuntime: (options) => {
          runtimeOptions = options
          return fixedRuntime
        }
      })

      expect(owner.hasActiveWork()).toBe(false)
      const admission = await owner.admit()
      expect(owner.hasActiveWork()).toBe(true)

      expect(admission.model).toBe(target.model.id)
      expect(admission.reviewerAcpRuntime).toBe(fixedRuntime)
      expect(
        runtimeOptions?.resolveBackend?.({
          forcedSkillIds: [],
          systemPromptAppends: ['reviewer rubric']
        })
      ).toBe(backend)
      expect(resolveTarget).toHaveBeenCalledWith(target, {
        forcedSkillIds: [],
        systemPromptAppends: []
      })
      expect(() =>
        runtimeOptions?.resolveBackend?.({ forcedSkillIds: [], systemPromptAppends: [] })
      ).toThrow('no longer available')

      await admission.release()
      expect(owner.hasActiveWork()).toBe(false)
      expect(shutdownForQuit).toHaveBeenCalledOnce()
    }
  )

  it('shuts down every admitted runtime and closes further admission', async () => {
    const shutdownForQuit = vi.fn(async () => ({ reaped: true }))
    const releaseBridge = vi.fn(async () => undefined)
    const fixedRuntime = {
      buildReviewerSession: vi.fn(),
      disposeReviewerSession: vi.fn(),
      sendPrompt: vi.fn(),
      shutdownForQuit
    } as unknown as AcpRuntime
    const target = {
      frameworkId: 'claude-code' as const,
      providerId: 'reviewer-provider',
      model: { kind: 'required' as const, id: 'reviewer-model' },
      reasoningEffort: 'high' as const
    }
    const owner = new ReviewerModelRuntimeOwner({
      appVersion: 'test',
      captureModel: async () => ({ model: 'reviewer-model', fixedTarget: target }),
      resolveTarget: vi.fn(
        async () =>
          ({
            framework: { id: 'claude-code' },
            executablePath: '/agent',
            env: {},
            responsesBridgeLease: { release: releaseBridge }
          }) as unknown as ResolvedAgentBackend
      ),
      createRuntime: () => fixedRuntime
    })

    const admission = await owner.admit()
    await owner.shutdown()

    expect(shutdownForQuit).toHaveBeenCalledOnce()
    expect(releaseBridge).toHaveBeenCalledOnce()
    await admission.release()
    expect(shutdownForQuit).toHaveBeenCalledOnce()
    await expect(owner.admit()).rejects.toThrow('shutting down')
  })

  it('releases a fixed backend that resolves after shutdown starts', async () => {
    let finishResolution: ((backend: ResolvedAgentBackend) => void) | undefined
    const releaseBridge = vi.fn(async () => undefined)
    const resolution = new Promise<ResolvedAgentBackend>((resolve) => {
      finishResolution = resolve
    })
    const createRuntime = vi.fn()
    const resolveTarget = vi.fn(() => resolution)
    const owner = new ReviewerModelRuntimeOwner({
      appVersion: 'test',
      captureModel: async () => ({
        model: 'reviewer-model',
        fixedTarget: {
          frameworkId: 'claude-code',
          providerId: 'reviewer-provider',
          model: { kind: 'required', id: 'reviewer-model' },
          reasoningEffort: 'high'
        }
      }),
      resolveTarget,
      createRuntime
    })

    const admission = owner.admit()
    await vi.waitFor(() => expect(resolveTarget).toHaveBeenCalledOnce())
    expect(owner.hasActiveWork()).toBe(true)
    let shutdownFinished = false
    const shutdown = owner.shutdown().then(() => {
      shutdownFinished = true
    })
    await Promise.resolve()
    expect(shutdownFinished).toBe(false)
    finishResolution?.({
      framework: { id: 'claude-code' },
      executablePath: '/agent',
      env: {},
      responsesBridgeLease: { release: releaseBridge }
    } as unknown as ResolvedAgentBackend)

    await expect(admission).rejects.toThrow('shutting down')
    await shutdown
    expect(owner.hasActiveWork()).toBe(false)
    expect(releaseBridge).toHaveBeenCalledOnce()
    expect(createRuntime).not.toHaveBeenCalled()
  })

  it('uses a non-latching update gate before admitting a fresh runtime', async () => {
    let finishFirstShutdown: ((outcome: { reaped: boolean }) => void) | undefined
    const firstShutdownOutcome = new Promise<{ reaped: boolean }>((resolve) => {
      finishFirstShutdown = resolve
    })
    const firstShutdown = vi.fn(() => firstShutdownOutcome)
    const secondShutdown = vi.fn(async () => ({ reaped: true }))
    const runtimes = [firstShutdown, secondShutdown].map(
      (shutdownForQuit) =>
        ({
          buildReviewerSession: vi.fn(),
          disposeReviewerSession: vi.fn(),
          sendPrompt: vi.fn(),
          shutdownForQuit
        }) as unknown as AcpRuntime
    )
    const owner = new ReviewerModelRuntimeOwner({
      appVersion: 'test',
      captureModel: async () => ({
        model: 'reviewer-model',
        fixedTarget: {
          frameworkId: 'claude-code',
          providerId: 'reviewer-provider',
          model: { kind: 'required', id: 'reviewer-model' },
          reasoningEffort: 'high'
        }
      }),
      resolveTarget: vi.fn(
        async () =>
          ({
            framework: { id: 'claude-code' },
            executablePath: '/agent',
            env: {}
          }) as ResolvedAgentBackend
      ),
      createRuntime: vi.fn(() => {
        const runtime = runtimes.shift()
        if (!runtime) throw new Error('Unexpected Reviewer runtime creation.')
        return runtime
      })
    })

    const firstAdmission = await owner.admit()

    const updateGate = owner.shutdownForUpdateGate()
    await vi.waitFor(() => expect(firstShutdown).toHaveBeenCalledOnce())
    await expect(owner.admit()).rejects.toThrow(
      'Reviewer cannot start while an update is preparing to install.'
    )
    finishFirstShutdown?.({ reaped: true })
    await expect(updateGate).resolves.toEqual({ reaped: true })
    await firstAdmission.release()
    expect(firstShutdown).toHaveBeenCalledOnce()

    const secondAdmission = await owner.admit()
    expect(secondAdmission.reviewerAcpRuntime).toBeDefined()
    await expect(owner.shutdown()).resolves.toEqual({ reaped: true })
    expect(secondShutdown).toHaveBeenCalledOnce()
  })

  it('makes shutdown await a release that is already closing its runtime', async () => {
    let finishRuntimeShutdown: ((outcome: { reaped: boolean }) => void) | undefined
    const runtimeShutdown = new Promise<{ reaped: boolean }>((resolve) => {
      finishRuntimeShutdown = resolve
    })
    const shutdownForQuit = vi.fn(() => runtimeShutdown)
    const fixedRuntime = {
      buildReviewerSession: vi.fn(),
      disposeReviewerSession: vi.fn(),
      sendPrompt: vi.fn(),
      shutdownForQuit
    } as unknown as AcpRuntime
    const owner = new ReviewerModelRuntimeOwner({
      appVersion: 'test',
      captureModel: async () => ({
        model: 'reviewer-model',
        fixedTarget: {
          frameworkId: 'claude-code',
          providerId: 'reviewer-provider',
          model: { kind: 'required', id: 'reviewer-model' },
          reasoningEffort: 'high'
        }
      }),
      resolveTarget: vi.fn(
        async () =>
          ({
            framework: { id: 'claude-code' },
            executablePath: '/agent',
            env: {}
          }) as ResolvedAgentBackend
      ),
      createRuntime: () => fixedRuntime
    })
    const admission = await owner.admit()

    const release = admission.release()
    await vi.waitFor(() => expect(shutdownForQuit).toHaveBeenCalledOnce())
    let shutdownFinished = false
    const shutdown = owner.shutdown().then(() => {
      shutdownFinished = true
    })
    await Promise.resolve()
    expect(shutdownFinished).toBe(false)

    finishRuntimeShutdown?.({ reaped: true })
    await Promise.all([release, shutdown])
    expect(shutdownForQuit).toHaveBeenCalledOnce()
  })

  it('turns an unavailable fixed backend into an actionable Reviewer runtime failure', async () => {
    const createRuntime = vi.fn()
    const owner = new ReviewerModelRuntimeOwner({
      appVersion: 'test',
      captureModel: async () => ({
        model: 'removed-model',
        fixedTarget: {
          frameworkId: 'codex',
          providerId: 'removed-provider',
          model: { kind: 'required', id: 'removed-model' },
          reasoningEffort: 'high'
        }
      }),
      resolveTarget: vi.fn(async () => {
        throw new Error('No active model provider is configured.')
      }),
      createRuntime
    })

    const admission = await owner.admit()

    expect(admission.model).toBe('removed-model')
    expect(createRuntime).not.toHaveBeenCalled()
    await expect(
      admission.reviewerAcpRuntime?.buildReviewerSession({ cwd: '/work', mcpServers: [] })
    ).rejects.toThrow(
      'The configured Reviewer model is unavailable: No active model provider is configured.'
    )
  })

  it('keeps Follow Active on the existing scoped runtime path', async () => {
    const createRuntime = vi.fn()
    const owner = new ReviewerModelRuntimeOwner({
      appVersion: 'test',
      captureModel: async () => ({ model: 'active-model' }),
      resolveTarget: vi.fn(),
      createRuntime
    })

    const admission = await owner.admit()

    expect(admission.model).toBe('active-model')
    expect(admission.reviewerAcpRuntime).toBeUndefined()
    expect(createRuntime).not.toHaveBeenCalled()
    await admission.release()
  })
})
