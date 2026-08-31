import { describe, expect, it } from 'vitest'

import type { SessionActionabilityProjection } from '@/stores/session-store'
import { resolveWorkspaceAgentControlAvailability } from './workspace-agent-control-availability'

const allowedActions = {
  changeAgentControls: { allowed: true },
  changeAutoReview: { allowed: true },
  changeMemory: { allowed: true },
  changeSpecialist: { allowed: true }
} as SessionActionabilityProjection['actions']

describe('resolveWorkspaceAgentControlAvailability', () => {
  it('keeps only local Auto-review editable during a Specialist context replacement', () => {
    expect(resolveWorkspaceAgentControlAvailability(true, true, allowedActions)).toEqual({
      canChange: false,
      canChangeAutoReview: true,
      canChangeMemory: false,
      canChangeSpecialist: false
    })
  })

  it('honors each projected action independently after the common gate opens', () => {
    expect(
      resolveWorkspaceAgentControlAvailability(true, false, {
        ...allowedActions,
        changeAgentControls: { allowed: false, disabledReason: 'session-pending' }
      })
    ).toEqual({
      canChange: false,
      canChangeAutoReview: true,
      canChangeMemory: true,
      canChangeSpecialist: true
    })
  })

  it('closes every control until the session is ready', () => {
    expect(resolveWorkspaceAgentControlAvailability(false, false, allowedActions)).toEqual({
      canChange: false,
      canChangeAutoReview: false,
      canChangeMemory: false,
      canChangeSpecialist: false
    })
  })
})
