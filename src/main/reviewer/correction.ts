// Auditor correction: after a review with warn/fail findings completes,
// injects one [Auditor] message into the main session.
//
// Phase 3: correction.ts no longer hardcodes unaddressed resolutions.
// The fix loop in orchestrator.ts drives re-review and sets resolutions from those results.

import { randomUUID } from 'node:crypto'

import type { ReviewerAcpRuntime } from './acp-runtime'
import { createLogger } from '../logger'
import type { ReviewCheck } from '../../shared/reviewer'
import type { AgentTurnProvenanceContext } from '../../shared/elicitation'

const log = createLogger('reviewer:correction')

// Builds the [Auditor] message body per design.md §6:
//
//   [Auditor] A fresh-context reviewer traced your work and found N issues:
//     1. [fail] "<claim>"  — <evidence>
//     2. [warn] ...
//   Acknowledge in one line and make the fix (or rebut in one line if a finding is wrong). Don't restate or narrate your evaluation.
export const buildAuditorMessage = (checks: ReviewCheck[]): string => {
  const n = checks.length
  const issueWord = n === 1 ? 'issue' : 'issues'
  const header = `[Auditor] A fresh-context reviewer traced your work and found ${n} ${issueWord}:`

  const lines = checks.map((c, i) => {
    const num = i + 1
    return `  ${num}. [${c.status}] "${c.claim}"  — ${c.evidence}`
  })

  const footer =
    "Acknowledge in one line and make the fix (or rebut in one line if a finding is wrong). Don't restate or narrate your evaluation."

  return [header, ...lines, footer].join('\n')
}

export type ReviewerCorrectionRequest = Readonly<{
  projectId: string
  sessionId: string
  causeReviewId: string
  checks: readonly ReviewCheck[]
  provenanceContext: AgentTurnProvenanceContext
}>

export type ReviewerCorrectionResult =
  | Readonly<{ status: 'skipped'; reason: 'no-open-checks' }>
  | Readonly<{ status: 'completed'; promptMessageId: string }>
  | Readonly<{ status: 'failed'; error: string }>

export class ReviewerCorrectionOwner {
  constructor(
    private readonly options: {
      acpRuntime: Pick<ReviewerAcpRuntime, 'sendApplicationPrompt'>
      onCorrectionPrompt?: (text: string) => void
      createPromptMessageId?: () => string
    }
  ) {}

  async request(input: ReviewerCorrectionRequest): Promise<ReviewerCorrectionResult> {
    const openChecks = input.checks.filter(
      (check) => check.status === 'warn' || check.status === 'fail'
    )
    if (openChecks.length === 0) {
      log.info('no warn/fail checks; skipping reviewer correction', {
        projectId: input.projectId,
        sessionId: input.sessionId,
        causeReviewId: input.causeReviewId
      })
      return { status: 'skipped', reason: 'no-open-checks' }
    }

    const promptMessageId = this.options.createPromptMessageId?.() ?? `prompt-${randomUUID()}`
    const provenanceContext = { ...input.provenanceContext, promptMessageId }
    const text = buildAuditorMessage(openChecks)
    this.options.onCorrectionPrompt?.(text)
    log.info('sending Reviewer Correction application turn', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      causeReviewId: input.causeReviewId,
      findingCount: openChecks.length
    })

    try {
      await this.options.acpRuntime.sendApplicationPrompt(
        { sessionId: input.sessionId, text, provenanceContext },
        {
          kind: 'application',
          feature: 'reviewer',
          purpose: 'correction',
          causeReviewId: input.causeReviewId
        }
      )
      log.info('Reviewer Correction turn complete', {
        sessionId: input.sessionId,
        causeReviewId: input.causeReviewId
      })
      return { status: 'completed', promptMessageId }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error('Reviewer Correction application turn failed', {
        sessionId: input.sessionId,
        causeReviewId: input.causeReviewId,
        error: errorMessage
      })
      return { status: 'failed', error: errorMessage }
    }
  }
}
