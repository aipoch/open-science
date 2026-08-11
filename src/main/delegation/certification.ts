const DELEGATED_WORK_CERTIFICATION_JOURNEYS = [
  'single',
  'detached',
  'array',
  'permission',
  'stop-restart',
  'messaging',
  'evidence'
] as const

type DelegatedWorkCertificationJourney = (typeof DELEGATED_WORK_CERTIFICATION_JOURNEYS)[number]
type DelegatedWorkJourneyResult = Readonly<{
  status: 'passed' | 'failed'
  /** Untrusted test/adapter detail. It is deliberately never copied into a public diagnostic. */
  detail?: unknown
}>
type NativeDelegationEntryPoint = 'task' | 'agent' | 'multi-agent'
type NativeDelegationAudit = Readonly<{
  entryPoint: NativeDelegationEntryPoint
  status: 'disabled' | 'not-present' | 'enabled' | 'unknown'
  /** Untrusted provider detail. It is deliberately never copied into a public diagnostic. */
  detail?: unknown
}>
type DelegatedWorkCertificationInput = Readonly<{
  frameworkId: string
  journeys: Partial<Record<DelegatedWorkCertificationJourney, DelegatedWorkJourneyResult>>
  nativeEntryPoints: readonly NativeDelegationAudit[]
}>
type DelegatedWorkCertificationDiagnosticCode =
  | 'journey-not-certified'
  | 'journey-failed'
  | 'native-entry-point-not-audited'
  | 'native-entry-point-unsafe'
type DelegatedWorkCertificationDiagnostic = Readonly<{
  code: DelegatedWorkCertificationDiagnosticCode
  message: string
  journey?: DelegatedWorkCertificationJourney
  entryPoint?: NativeDelegationEntryPoint
}>
type DelegatedWorkCertification = Readonly<{
  frameworkId: string
  status: 'certified' | 'unavailable'
  diagnostics: readonly DelegatedWorkCertificationDiagnostic[]
}>

const NATIVE_DELEGATION_ENTRY_POINTS = ['task', 'agent', 'multi-agent'] as const

/**
 * Produces the only public certification projection. Raw adapter failures are intentionally ignored:
 * provider stacks, credentials, prompt bytes, and capability tokens must stay in private logs.
 */
const evaluateDelegatedWorkCertification = (
  input: DelegatedWorkCertificationInput
): DelegatedWorkCertification => {
  const diagnostics: DelegatedWorkCertificationDiagnostic[] = []
  for (const journey of DELEGATED_WORK_CERTIFICATION_JOURNEYS) {
    const result = input.journeys[journey]
    if (!result) {
      diagnostics.push({
        code: 'journey-not-certified',
        journey,
        message: `Delegated work remains unavailable. Run the ${journey} certification journey.`
      })
    } else if (result.status !== 'passed') {
      diagnostics.push({
        code: 'journey-failed',
        journey,
        message: `Delegated work remains unavailable. Re-run the ${journey} journey after fixing its observable contract failure.`
      })
    }
  }

  for (const entryPoint of NATIVE_DELEGATION_ENTRY_POINTS) {
    const audit = input.nativeEntryPoints.find((candidate) => candidate.entryPoint === entryPoint)
    if (!audit) {
      diagnostics.push({
        code: 'native-entry-point-not-audited',
        entryPoint,
        message: `Delegated work remains unavailable. Audit the native ${entryPoint} entry point and prove it cannot bypass app-owned delegation.`
      })
    } else if (audit.status !== 'disabled' && audit.status !== 'not-present') {
      diagnostics.push({
        code: 'native-entry-point-unsafe',
        entryPoint,
        message: `Delegated work remains unavailable. Disable the native ${entryPoint} entry point before enabling framework support.`
      })
    }
  }

  return Object.freeze({
    frameworkId: input.frameworkId,
    status: diagnostics.length === 0 ? 'certified' : 'unavailable',
    diagnostics: Object.freeze(diagnostics)
  })
}

const assertDelegatedWorkCertified = (certification: DelegatedWorkCertification): void => {
  if (certification.status === 'certified') return
  const codes = [...new Set(certification.diagnostics.map(({ code }) => code))]
  throw new Error(
    `Delegated work is unavailable for ${certification.frameworkId}. Certification diagnostics: ${codes.join(', ')}.`
  )
}

const nativeDelegationAuditFailureMessage = (frameworkId: string): string =>
  `Delegated work is unavailable for ${frameworkId} because its native Task/Agent/multi-agent bypass audit failed. Disable every native delegation entry point and re-run framework certification.`

export {
  DELEGATED_WORK_CERTIFICATION_JOURNEYS,
  assertDelegatedWorkCertified,
  evaluateDelegatedWorkCertification,
  nativeDelegationAuditFailureMessage
}
export type {
  DelegatedWorkCertification,
  DelegatedWorkCertificationDiagnostic,
  DelegatedWorkCertificationDiagnosticCode,
  DelegatedWorkCertificationInput,
  DelegatedWorkCertificationJourney,
  DelegatedWorkJourneyResult,
  NativeDelegationAudit,
  NativeDelegationEntryPoint
}
