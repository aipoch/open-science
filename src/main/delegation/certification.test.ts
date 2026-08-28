import { describe, expect, it } from 'vitest'

import { listAgentFrameworks } from '../agent-framework'
import {
  DELEGATED_WORK_CERTIFICATION_JOURNEYS,
  assertDelegatedWorkCertified,
  evaluateDelegatedWorkCertification
} from './certification'

const passingJourneys = Object.fromEntries(
  DELEGATED_WORK_CERTIFICATION_JOURNEYS.map((journey) => [journey, { status: 'passed' as const }])
)

const disabledNativeEntryPoints = [
  { entryPoint: 'task' as const, status: 'disabled' as const },
  { entryPoint: 'agent' as const, status: 'not-present' as const },
  { entryPoint: 'multi-agent' as const, status: 'disabled' as const }
]

describe('delegated-work framework certification', () => {
  it('advertises certification status for every framework', () => {
    expect(
      listAgentFrameworks().map(({ id, supportsDelegatedWork }) => ({
        id,
        supportsDelegatedWork
      }))
    ).toEqual([
      { id: 'claude-code', supportsDelegatedWork: true },
      { id: 'opencode', supportsDelegatedWork: true },
      { id: 'codex', supportsDelegatedWork: true },
      { id: 'codebuddy', supportsDelegatedWork: true }
    ])
  })

  it('certifies only a complete journey matrix with every native bypass closed', () => {
    expect(
      evaluateDelegatedWorkCertification({
        frameworkId: 'certified-test',
        journeys: passingJourneys,
        nativeEntryPoints: disabledNativeEntryPoints
      })
    ).toEqual({
      frameworkId: 'certified-test',
      status: 'certified',
      diagnostics: []
    })
  })

  it('fails closed for a missing journey or unaudited native entry point', () => {
    const incompleteJourneys = { ...passingJourneys } as Partial<typeof passingJourneys>
    delete incompleteJourneys.single
    const result = evaluateDelegatedWorkCertification({
      frameworkId: 'candidate',
      journeys: incompleteJourneys,
      nativeEntryPoints: [{ entryPoint: 'task', status: 'unknown', detail: 'secret raw detail' }]
    })

    expect(result.status).toBe('unavailable')
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      'journey-not-certified',
      'native-entry-point-unsafe',
      'native-entry-point-not-audited',
      'native-entry-point-not-audited'
    ])
  })

  it('returns actionable diagnostics without copying provider errors, prompts, tokens, or stacks', () => {
    const sensitive = [
      'sk-provider-secret',
      'capability-token-secret',
      'verbatim private prompt',
      '/provider/internal.ts:42'
    ].join(' ')
    const result = evaluateDelegatedWorkCertification({
      frameworkId: 'candidate',
      journeys: {
        ...passingJourneys,
        permission: { status: 'failed', detail: sensitive }
      },
      nativeEntryPoints: [
        ...disabledNativeEntryPoints.slice(0, 2),
        { entryPoint: 'multi-agent', status: 'enabled', detail: sensitive }
      ]
    })

    const text = JSON.stringify(result)
    expect(text).not.toContain('sk-provider-secret')
    expect(text).not.toContain('capability-token-secret')
    expect(text).not.toContain('verbatim private prompt')
    expect(text).not.toContain('/provider/internal.ts:42')
    expect(text).toContain('Re-run the permission journey')
    expect(text).toContain('Disable the native multi-agent entry point')
    expect(() => assertDelegatedWorkCertified(result)).toThrowError(
      'Delegated work is unavailable for candidate. Certification diagnostics: journey-failed, native-entry-point-unsafe.'
    )
  })
})
