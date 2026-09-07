import { describe, expect, it, vi } from 'vitest'

import { ComputeJobRepository } from './job-repository'

import {
  createDeletionRuntimeHarness,
  deletionCases
} from './job-deletion-runtime-isolation.test-support'

describe('Compute Job deletion runtime isolation', () => {
  it.each([
    ...deletionCases.map((deletionCase) => ({ ...deletionCase, pollDelayMs: 0 })),
    { ...deletionCases[0], pollDelayMs: 750 }
  ])(
    'keeps another Session polling when $name remote cleanup fails after authority commits (poll delay: $pollDelayMs ms)',
    async (deletionCase) => {
      const harness = await createDeletionRuntimeHarness(deletionCase)
      const findNonTerminal = ComputeJobRepository.prototype.findNonTerminal
      const delayedPoll = deletionCase.pollDelayMs
        ? vi
            .spyOn(ComputeJobRepository.prototype, 'findNonTerminal')
            .mockImplementationOnce(async function (this: ComputeJobRepository) {
              const jobs = await findNonTerminal.call(this)
              await new Promise((resolve) => setTimeout(resolve, deletionCase.pollDelayMs))
              return jobs
            })
        : undefined
      try {
        await expect(harness.deleteOwner()).rejects.toThrow(
          'The Compute Host could not be reached.'
        )
        expect(harness.authorityCommitted()).toBe(true)
        await expect(harness.deletedStatus()).resolves.toMatchObject({ status: 'success' })

        await harness.runScheduledPoll()
        await expect(harness.survivorStatus()).resolves.toMatchObject({
          status: 'success',
          exit_code: 0
        })
      } finally {
        delayedPoll?.mockRestore()
        await harness.dispose()
      }
    }
  )
})
