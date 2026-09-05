import { describe, expect, it } from 'vitest'

import { planTestProjection } from './plan-test-fixtures'
import { resolvePlanFileProjection, snapshotPlanProjection } from './plan-file-projection'

describe('plan file projection resolution', () => {
  it('resolves a Session Plan projection from the plan history by version id', () => {
    const historical = planTestProjection('version-history')

    const resolved = resolvePlanFileProjection(
      {
        planHistoryProjections: [historical],
        activePlanProjection: planTestProjection('version-current')
      },
      'version-history'
    )

    expect(resolved).toEqual({ projection: historical, stale: true })
  })

  it('matches the active projection when history has no entry for the version', () => {
    const active = planTestProjection('version-current')

    const resolved = resolvePlanFileProjection(
      { planHistoryProjections: [], activePlanProjection: active },
      'version-current'
    )

    expect(resolved).toEqual({ projection: active, stale: false })
  })

  it('prefers updated active progress when history has the same version id', () => {
    const historical = planTestProjection('version-1')
    const active = {
      ...historical,
      revision: 7,
      lifecycle: 'in_progress' as const,
      stepStatuses: {
        'Analyze the data': { status: 'in_progress' as const, updatedAt: 42 }
      },
      stepStates: { 'Analyze the data': { status: 'in_progress' as const } },
      counts: { ...historical.counts, completed: 0, inProgress: 1 }
    }

    const resolved = resolvePlanFileProjection(
      { planHistoryProjections: [historical], activePlanProjection: active },
      'version-1'
    )

    expect(resolved).toEqual({ projection: active, stale: false })
  })

  it('marks a historical projection stale when runtime identifies a different current plan', () => {
    const historical = planTestProjection('version-history')

    const resolved = resolvePlanFileProjection(
      {
        planHistoryProjections: [historical],
        runtimeContext: { plan: { artifactVersionId: 'version-current' } }
      },
      'version-history'
    )

    expect(resolved).toEqual({ projection: historical, stale: true })
  })

  it('keeps a historical projection current when it matches the runtime plan identity', () => {
    const current = planTestProjection('version-current')

    const resolved = resolvePlanFileProjection(
      {
        planHistoryProjections: [current],
        runtimeContext: { plan: { artifactVersionId: 'version-current' } }
      },
      'version-current'
    )

    expect(resolved).toEqual({ projection: current, stale: false })
  })

  it('returns undefined when no projection matches or identity is missing', () => {
    const session = {
      planHistoryProjections: [planTestProjection('version-other')],
      activePlanProjection: planTestProjection('version-active')
    }

    expect(resolvePlanFileProjection(session, 'version-unknown')).toBeUndefined()
    expect(resolvePlanFileProjection(session, undefined)).toBeUndefined()
    expect(resolvePlanFileProjection(undefined, 'version-other')).toBeUndefined()
  })
})

describe('snapshot plan projection', () => {
  it('projects every step as not started', () => {
    const snapshot = snapshotPlanProjection(planTestProjection('version-1').document)

    expect(snapshot.stepStates).toEqual({
      'Analyze the data': { status: 'not_started' }
    })
    expect(snapshot.stepStatuses).toEqual({})
  })

  it('projects a not-started state for every step across phases and delegations', () => {
    const snapshot = snapshotPlanProjection({
      schema_version: 1,
      task_summary: 'Two-phase plan',
      phases: [
        {
          name: 'First',
          delegations: [
            { name: 'A', steps: [{ title: 'A1', description: 'Do A1.' }] },
            {
              name: 'B',
              steps: [
                { title: 'B1', description: 'Do B1.' },
                { title: 'B2', description: 'Do B2.' }
              ]
            }
          ]
        },
        {
          name: 'Second',
          delegations: [{ name: 'C', steps: [{ title: 'C1', description: 'Do C1.' }] }]
        }
      ],
      desired_outputs: [],
      feasibility: { confidence: 'medium', rationale: 'Standard pipeline.' }
    })

    expect(snapshot.stepStates).toEqual({
      A1: { status: 'not_started' },
      B1: { status: 'not_started' },
      B2: { status: 'not_started' },
      C1: { status: 'not_started' }
    })
  })
})
