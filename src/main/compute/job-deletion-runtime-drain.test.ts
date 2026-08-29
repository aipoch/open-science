import { describe, expect, it, vi } from 'vitest'

import {
  createDeletionRuntimeHarness,
  deletionCases
} from './job-deletion-runtime-isolation.test-support'

describe('Compute Job deletion runtime drain boundary', () => {
  it('keeps another Session polling while remote cleanup planning is in flight', async () => {
    const sessionDeletion = deletionCases[0]
    const harness = await createDeletionRuntimeHarness(sessionDeletion, {
      holdCleanupPlanning: true
    })
    try {
      const deletion = harness.deleteOwner()
      void deletion.catch(() => undefined)
      await harness.cleanupPlanningStarted

      harness.runScheduledPoll()
      await vi.waitFor(
        async () => {
          await expect(harness.survivorStatus()).resolves.toMatchObject({
            status: 'success',
            exit_code: 0
          })
        },
        { timeout: 500, interval: 10 }
      )

      harness.releaseCleanupPlanning()
      await expect(deletion).rejects.toThrow('The Compute Host could not be reached.')
    } finally {
      await harness.dispose()
    }
  })

  it('keeps another Session polling while remote cleanup is still in flight', async () => {
    const sessionDeletion = deletionCases[0]
    const harness = await createDeletionRuntimeHarness(sessionDeletion, {
      holdRemoteCleanup: true
    })
    try {
      const deletion = harness.deleteOwner()
      await harness.cleanupStarted
      expect(harness.authorityCommitted()).toBe(true)

      harness.runScheduledPoll()
      await vi.waitFor(
        async () => {
          await expect(harness.survivorStatus()).resolves.toMatchObject({
            status: 'success',
            exit_code: 0
          })
        },
        { timeout: 500, interval: 10 }
      )

      harness.releaseRemoteCleanup()
      await expect(deletion).rejects.toThrow('The Compute Host could not be reached.')
    } finally {
      await harness.dispose()
    }
  })
})
