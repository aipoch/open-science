import { describe, expect, it, vi } from 'vitest'
import {
  createNotebookExecutionAdmission,
  guardNotebookExecutionAdmission,
  type NotebookMemoryRecheck
} from './execution-admission'
import { MemoryPolicyService, type MemoryPolicySample } from './memory-policy'

const healthy = (platform: 'win32' | 'linux', executionScope: string): MemoryPolicySample => ({
  platform,
  executionScope,
  source: 'controlled-admission-test',
  facts: {
    totalBytes: 1000,
    availableBytes: 800,
    commitLimitBytes: 1000,
    committedBytes: 100,
    ...(platform === 'linux' ? { overcommitMode: 2 as const } : {})
  }
})

describe('host and original execution-domain admission', () => {
  it.each(['pressure', 'cancelled'] as const)(
    'does not use a pre-click background sample for an explicit recheck (%s)',
    async (outcome) => {
      const available = healthy('win32', 'windows:host')
      const low = { ...available, facts: { ...available.facts, availableBytes: 2 } }
      const background = Promise.withResolvers<MemoryPolicySample>()
      const sample = vi.fn(async (): Promise<MemoryPolicySample> => low)
      sample.mockResolvedValueOnce(low).mockImplementationOnce(() => background.promise)
      const policy = new MemoryPolicyService({
        adapter: { platform: 'win32', defaultExecutionScope: 'windows:host', sample }
      })
      const controller = new AbortController()
      let recheck!: NotebookMemoryRecheck
      const admission = createNotebookExecutionAdmission({
        policy: async () => policy,
        onRejected: (_, retry) => {
          recheck = retry
        }
      })
      try {
        await expect(admission.prepare('submit')).rejects.toThrow('NOTEBOOK_MEMORY_PRESSURE')
        const polling = policy.getState({ force: true })
        await vi.waitFor(() => expect(sample).toHaveBeenCalledTimes(2))
        const checking = recheck(controller.signal)
        const result = expect(checking).rejects.toMatchObject(
          outcome === 'cancelled' ? { name: 'AbortError' } : { code: 'NOTEBOOK_MEMORY_PRESSURE' }
        )
        if (outcome === 'cancelled') {
          controller.abort()
          await result
        }
        background.resolve(available)
        await expect(polling).resolves.toMatchObject({ status: 'healthy' })
        await result
        expect(sample).toHaveBeenCalledTimes(outcome === 'cancelled' ? 2 : 3)
      } finally {
        background.resolve(available)
        policy.dispose()
      }
    }
  )

  it('allows fresh macOS warnings and recovery but refuses critical, invalidated and stale samples', async () => {
    let now = 0
    let pressureLevel: 'normal' | 'warning' | 'critical' = 'warning'
    let sequence = 1
    const policy = new MemoryPolicyService({
      adapter: {
        platform: 'darwin',
        sample: async () => ({
          platform: 'darwin',
          source: 'darwin-sysctl-dispatch',
          executionScope: 'darwin:host',
          facts: { pressureLevel, pressureEventSequence: sequence }
        })
      },
      now: () => now,
      wallNow: () => now
    })
    const onRejected = vi.fn()
    const admission = createNotebookExecutionAdmission({ policy: async () => policy, onRejected })
    try {
      await admission.prepare('dispatch')
      admission.assertCurrent('dispatch')
      expect(onRejected).not.toHaveBeenCalled()

      pressureLevel = 'critical'
      sequence++
      policy.invalidate({ pressureLevel })
      expect(() => admission.assertCurrent('dispatch')).toThrow('NOTEBOOK_MEMORY_UNAVAILABLE')
      await expect(admission.prepare('dispatch')).rejects.toThrow('NOTEBOOK_MEMORY_PRESSURE')

      pressureLevel = 'normal'
      policy.invalidate({ pressureLevel })
      await admission.prepare('dispatch')
      expect(policy.currentState().reason.code).toBe('mac-memory-recovering')
      admission.assertCurrent('dispatch')

      now = 2001
      expect(() => admission.assertCurrent('dispatch')).toThrow('NOTEBOOK_MEMORY_UNAVAILABLE')
    } finally {
      policy.dispose()
    }
  })

  it('checks host freshness again after awaiting the guest before the final dispatch commit', async () => {
    let now = 0
    const host = new MemoryPolicyService({
      adapter: { platform: 'win32', sample: async () => healthy('win32', 'windows:host') },
      now: () => now,
      wallNow: () => now
    })
    const guest = new MemoryPolicyService({
      adapter: {
        platform: 'linux',
        sample: async () => {
          now = 2001
          return healthy('linux', 'wsl:original')
        }
      },
      now: () => now,
      wallNow: () => now
    })
    const rejected = vi.fn()
    const admission = createNotebookExecutionAdmission({
      policy: async () => host,
      onRejected: rejected
    }).withExecutionDomain!(guest, 'wsl:original')
    try {
      await host.getState()
      now = 1000
      await admission.prepare('dispatch')
      expect(() => admission.assertCurrent('dispatch')).toThrow('NOTEBOOK_MEMORY_UNAVAILABLE')
      expect(rejected).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'unavailable',
          reason: { code: 'sample-expired' }
        }),
        expect.any(Function)
      )
    } finally {
      host.dispose()
      guest.dispose()
    }
  })

  it('leaves a WSL refusal stopped when its exact execution domain is gone', async () => {
    const hostSample = vi.fn(async () => healthy('win32', 'windows:host'))
    const host = new MemoryPolicyService({
      adapter: { platform: 'win32', sample: hostSample }
    })
    const executionScope = 'wsl:original'
    const available = healthy('linux', executionScope)
    const guest = new MemoryPolicyService({
      adapter: {
        platform: 'linux',
        defaultExecutionScope: executionScope,
        sample: async () => ({ ...available, facts: { ...available.facts, availableBytes: 2 } })
      }
    })
    let recheck!: NotebookMemoryRecheck
    const admission = createNotebookExecutionAdmission({
      policy: async () => host,
      onRejected: (_, retry) => {
        recheck = retry
      }
    }).withExecutionDomain!(guest, executionScope)
    try {
      await expect(admission.prepare('dispatch')).rejects.toThrow('NOTEBOOK_MEMORY_PRESSURE')
      guest.dispose()
      await expect(recheck(new AbortController().signal)).rejects.toMatchObject({
        code: 'NOTEBOOK_MEMORY_UNAVAILABLE',
        message: expect.stringContaining(
          'original Notebook execution domain is no longer available'
        ),
        memory: expect.objectContaining({ executionScope })
      })
      expect(hostSample).toHaveBeenCalledOnce()
    } finally {
      host.dispose()
      guest.dispose()
    }
  })

  it.each([false, true])(
    'preserves the same authenticated force=%s through owner and lifetime guards',
    async (force) => {
      const hostGetState = vi.fn(async () => ({
        status: 'healthy' as const,
        source: 'host',
        executionScope: 'windows:host',
        reason: { code: 'healthy' }
      }))
      const guestGetState = vi.fn(async () => ({
        status: 'healthy' as const,
        source: 'guest',
        executionScope: 'wsl:original',
        reason: { code: 'healthy' }
      }))
      const host = {
        getState: hostGetState,
        currentState: () => ({
          status: 'healthy' as const,
          source: 'host',
          executionScope: 'windows:host',
          reason: { code: 'healthy' }
        })
      }
      const guest = {
        getState: guestGetState,
        currentState: () => ({
          status: 'healthy' as const,
          source: 'guest',
          executionScope: 'wsl:original',
          reason: { code: 'healthy' }
        })
      }
      let current = true
      const controller = new AbortController()
      const guarded = guardNotebookExecutionAdmission(
        createNotebookExecutionAdmission({ policy: async () => host, force }),
        controller.signal,
        () => {
          if (!current) throw new Error('owner replaced')
        }
      )!
      const admission = guarded.withExecutionDomain!(guest, 'wsl:original')
      await admission.prepare('dispatch')
      admission.assertCurrent('dispatch')
      expect(hostGetState).toHaveBeenCalledWith(expect.objectContaining({ force }))
      expect(guestGetState).toHaveBeenCalledWith(
        expect.objectContaining({ force, executionScope: 'wsl:original' })
      )
      current = false
      expect(() => admission.assertCurrent('dispatch')).toThrow('owner replaced')
      await expect(admission.prepare('dispatch')).rejects.toThrow('owner replaced')
      expect(guestGetState).toHaveBeenCalledTimes(1)
    }
  )
})
