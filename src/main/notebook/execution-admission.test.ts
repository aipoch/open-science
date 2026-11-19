import { describe, expect, it, vi } from 'vitest'
import {
  createNotebookExecutionAdmission,
  guardNotebookExecutionAdmission
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
        })
      )
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
