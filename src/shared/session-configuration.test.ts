import { describe, expect, it } from 'vitest'

import {
  updateProjectSessionDefaultsRequestSchema,
  updateSessionConfigurationRequestSchema
} from './session-configuration'

describe('Session configuration contracts', () => {
  it('keeps selected Compute Hosts inside the enabled set', () => {
    expect(
      updateSessionConfigurationRequestSchema.safeParse({
        expectedRevision: 1,
        computeHosts: { enabled: ['ssh:alpha'], selected: ['ssh:beta'] }
      }).success
    ).toBe(false)
  })

  it('allows Project defaults to be explicitly cleared without adding Session null states', () => {
    expect(
      updateProjectSessionDefaultsRequestSchema.parse({
        expectedUpdatedAt: 1,
        patch: {
          agentConfiguration: null,
          memoryEnabled: null,
          computeHosts: null
        }
      })
    ).toMatchObject({
      patch: { agentConfiguration: null, memoryEnabled: null, computeHosts: null }
    })
    expect(
      updateSessionConfigurationRequestSchema.safeParse({
        expectedRevision: 1,
        memoryEnabled: null
      }).success
    ).toBe(false)
  })

  it('rejects unknown fields at both mutation boundaries', () => {
    expect(
      updateSessionConfigurationRequestSchema.safeParse({
        expectedRevision: 1,
        futureOption: true
      }).success
    ).toBe(false)
    expect(
      updateProjectSessionDefaultsRequestSchema.safeParse({
        expectedUpdatedAt: 1,
        patch: { futureOption: true }
      }).success
    ).toBe(false)
  })
})
