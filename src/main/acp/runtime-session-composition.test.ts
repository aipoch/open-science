import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ContextUsageTracker } from './context-usage-tracker'
import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'

describe('ACP Runtime session composition', () => {
  it('builds a fresh frozen owner graph around the supplied base owners', () => {
    const contextUsageTracker = new ContextUsageTracker()
    const options = {
      appVersion: 'test',
      defaultCwd: '/workspace',
      contextUsageTracker
    }
    const firstBase = composeAcpRuntimeBaseOwners(options)
    const secondBase = composeAcpRuntimeBaseOwners(options)
    const first = composeAcpRuntimeSessionOwners(options, firstBase)
    const second = composeAcpRuntimeSessionOwners(options, secondBase)

    expect(Object.isFrozen(first)).toBe(true)
    expect(first.sessionRegistry).not.toBe(second.sessionRegistry)
    expect(first.sessionEnvironment).not.toBe(second.sessionEnvironment)
    expect(first.contextUsagePolicy).not.toBe(second.contextUsagePolicy)
    expect(first.publication).not.toBe(second.publication)
    expect(first.permissionContext).not.toBe(second.permissionContext)
    expect(first.reviewerSessions).not.toBe(second.reviewerSessions)
    expect(first.sessionUpdateProjector).not.toBe(second.sessionUpdateProjector)
    expect(first.publication.getSnapshot()).toMatchObject({
      cwd: resolve('/workspace'),
      sessionIds: [],
      contextUsageBySession: {}
    })
  })
})
