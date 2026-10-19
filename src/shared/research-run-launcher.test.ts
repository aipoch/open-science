import { describe, expect, it } from 'vitest'
import {
  inspectResearchRunRequestSchema,
  researchRunPlanBlockReasons,
  type ResearchRunPlan
} from './research-run-launcher'

const plan: ResearchRunPlan = {
  key: 'check',
  title: 'Check',
  scope: 'engineering-check',
  claim: 'Check',
  limitations: [],
  materialKeys: ['code'],
  materials: [{ key: 'code', status: 'available' }],
  materialReady: true,
  compatibleRuntimeIds: ['runtime'],
  entrypoints: [{ materialKey: 'code' }],
  requiresSecrets: false
}
describe('research launcher contract', () => {
  it('keeps source inspection free of target sessions and execution commands', () => {
    const request = { projectId: 'project', sourceSessionId: 'source', sourceImportId: 'import' }
    expect(inspectResearchRunRequestSchema.parse(request)).toEqual(request)
    for (const extra of [{ sessionId: 'target' }, { command: 'run' }, { cwd: '/tmp' }])
      expect(inspectResearchRunRequestSchema.safeParse({ ...request, ...extra }).success).toBe(
        false
      )
  })
  it('allows a described local headless plan and reports every concrete blocker', () => {
    expect(researchRunPlanBlockReasons(plan)).toEqual([])
    expect(
      researchRunPlanBlockReasons({
        ...plan,
        materialReady: false,
        compatibleRuntimeIds: [],
        entrypoints: [],
        requiresSecrets: true
      })
    ).toEqual([
      'materials-unavailable',
      'runtime-unavailable',
      'entrypoint-unavailable',
      'secrets-required'
    ])
  })
})
