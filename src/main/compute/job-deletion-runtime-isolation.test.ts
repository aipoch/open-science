import { describe, expect, it, vi } from 'vitest'

import {
  createDeletionRuntimeHarness,
  deletionCases
} from './job-deletion-runtime-isolation.test-support'

describe('Compute Job deletion runtime isolation', () => {
  it.each(deletionCases)(
    'keeps another Session polling when $name remote cleanup fails after authority commits',
    async (deletionCase) => {
      const harness = await createDeletionRuntimeHarness(deletionCase)
      try {
        await expect(harness.deleteOwner()).rejects.toThrow(
          'The Compute Host could not be reached.'
        )
        expect(harness.authorityCommitted()).toBe(true)
        await expect(harness.deletedStatus()).resolves.toMatchObject({ status: 'success' })

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
      } finally {
        await harness.dispose()
      }
    }
  )
})
