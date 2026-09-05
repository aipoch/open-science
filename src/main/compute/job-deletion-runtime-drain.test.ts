import { describe, expect, it } from 'vitest'

import {
  createDeletionRuntimeHarness,
  deletionCases
} from './job-deletion-runtime-isolation.test-support'

describe('Compute Job deletion runtime drain boundary', () => {
  it.each([
    ['remote cleanup planning', 'planning'],
    ['remote cleanup', 'cleanup']
  ] as const)('keeps another Session polling while %s is in flight', async (_label, phase) => {
    const isPlanning = phase === 'planning'
    const sessionDeletion = deletionCases[0]
    const harness = await createDeletionRuntimeHarness(sessionDeletion, {
      holdCleanupPlanning: isPlanning,
      holdRemoteCleanup: !isPlanning
    })
    try {
      const deletion = harness.deleteOwner()
      if (isPlanning) void deletion.catch(() => undefined)
      await (isPlanning ? harness.cleanupPlanningStarted : harness.cleanupStarted)
      if (!isPlanning) expect(harness.authorityCommitted()).toBe(true)

      await harness.runScheduledPoll()
      await expect(harness.survivorStatus()).resolves.toMatchObject({
        status: 'success',
        exit_code: 0
      })

      if (isPlanning) harness.releaseCleanupPlanning()
      else harness.releaseRemoteCleanup()
      await expect(deletion).rejects.toThrow('The Compute Host could not be reached.')
    } finally {
      await harness.dispose()
    }
  })
})
