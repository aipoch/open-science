// Auditor correction: after a review with warn/fail findings completes,
// injects one [Auditor] message into the main session.
//
// Phase 3: correction.ts no longer hardcodes unaddressed resolutions.
// The fix loop in orchestrator.ts drives re-review and sets resolutions from those results.

import type { ReviewerAcpRuntime } from './acp-runtime'
import { createLogger } from '../logger'
import type { ReviewCheck } from '../../shared/reviewer'

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

// Injects the [Auditor] message into the main session and waits for the correction turn to complete.
// Resolution updates are NOT performed here — Phase 3 orchestrator drives re-review and sets
// resolutions from the re-review outcome.
//
// Errors are isolated: a failed correction is logged but does NOT crash the review lifecycle.
export const injectAuditorMessage = async (options: {
  sessionId: string
  mainSessionId: string
  findings: ReviewCheck[] // the full checks list; only warn/fail are injected
  acpRuntime: ReviewerAcpRuntime
  // Optional hook for tests to capture the injected message text.
  onCorrectionPrompt?: (text: string) => void
  // Called if the correction sendPrompt fails, so the caller can undo pre-emptive suppression.
  onCorrectionFailed?: () => void
}): Promise<void> => {
  const { sessionId, mainSessionId, findings, acpRuntime, onCorrectionPrompt, onCorrectionFailed } =
    options

  // Only inject for warn/fail checks.
  const warnFailChecks = findings.filter((c) => c.status === 'warn' || c.status === 'fail')
  if (warnFailChecks.length === 0) {
    log.info('no warn/fail checks; skipping auditor injection', { sessionId })
    return
  }

  const message = buildAuditorMessage(warnFailChecks)

  log.info('injecting [Auditor] message into main session', {
    sessionId,
    mainSessionId,
    findingCount: warnFailChecks.length
  })

  // Notify test hooks (if any).
  onCorrectionPrompt?.(message)

  try {
    // Inject through the main-session sendPrompt path (design.md cross-cutting requirement).
    // This is a normal prompt turn that the user sees in the conversation.
    await acpRuntime.sendPrompt({ sessionId: mainSessionId, text: message })
    log.info('[Auditor] correction turn complete', { mainSessionId })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('[Auditor] correction sendPrompt failed', {
      mainSessionId,
      error: errorMsg
    })
    // Error handling: a failed correction does NOT spin into a re-review loop.
    // The correction turn never produced a stop, so undo the pre-emptive auto-review suppression.
    onCorrectionFailed?.()
  }
}
