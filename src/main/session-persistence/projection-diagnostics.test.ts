import { describe, expect, it } from 'vitest'

import type { SessionLoadDiagnostics } from '../../shared/session-persistence'
import { SessionProjectionDiagnostics } from './projection-diagnostics'

const healthyDiagnostics = (): SessionLoadDiagnostics => ({
  isComplete: true,
  warnings: [],
  isProjectDeletionRecoveryComplete: true
})

describe('SessionProjectionDiagnostics', () => {
  it('preserves recovered authority warnings across projection-only startup reads', () => {
    const diagnostics = new SessionProjectionDiagnostics()
    const recovered: SessionLoadDiagnostics = {
      isComplete: true,
      warnings: [
        {
          kind: 'corrupt',
          projectId: 'project-a',
          fileName: 'broken.json',
          recovered: true
        }
      ],
      isProjectDeletionRecoveryComplete: true
    }

    expect(diagnostics.resolve(recovered)).toBe(recovered)
    expect(diagnostics.resolve(undefined)).toBe(recovered)
  })

  it('lets a fresh healthy authority result supersede a recovered warning', () => {
    const diagnostics = new SessionProjectionDiagnostics()
    diagnostics.resolve({
      isComplete: true,
      warnings: [
        {
          kind: 'manifest-corrupt',
          fileName: 'manifest.json',
          recovered: true
        }
      ]
    })
    const healthy = healthyDiagnostics()

    expect(diagnostics.resolve(healthy)).toBe(healthy)
    expect(diagnostics.resolve(undefined)).toEqual(healthyDiagnostics())
  })
})
