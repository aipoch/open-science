import { useState } from 'react'
import { classifyFailure } from '../../../../shared/failure/classify'
import type { ClassifiedFailure, FailureFacts } from '../../../../shared/failure/contract'
import type { TurnOutcome } from '../../../../shared/session-turn-outcome-contract'
import { noticePriority, type ComposerNotice } from './catalog'

export type ComposerOperationFailure = Readonly<{
  id: string
  code?: string
  message?: string | null
  detail?: string
  failure?: ClassifiedFailure
  occurredAt?: number
  origin?: FailureFacts['origin']
  blocksSend?: boolean
}>

export const useComposerNotices = (input: {
  sessionId?: string
  authenticationResolved?: boolean
  compacting?: boolean
  turn?: { promptMessageId: string; outcome: Exclude<TurnOutcome, { kind: 'completed' }> }
  recovery?: { error?: string; cause?: string }
  legacy?: { error?: string; failure?: ClassifiedFailure; updatedAt?: number }
  operations: readonly ComposerOperationFailure[]
}): {
  notices: ComposerNotice[]
  authenticationRequired: boolean
  dismiss: (notice: ComposerNotice) => void
} => {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const prefix = input.sessionId ?? 'draft'
  const notices: ComposerNotice[] = []
  const { turn, recovery, legacy } = input
  if (recovery)
    notices.push({
      id: `${prefix}:session:${recovery.cause}:${recovery.error ?? ''}`,
      source: 'session',
      occurredAt: turn?.outcome.settledAt ?? 0,
      blocksSend: true,
      failure: classifyFailure({ origin: 'session', text: recovery.error })
    })
  if (turn?.outcome.kind === 'failed')
    notices.push({
      id: `${prefix}:turn:${turn.promptMessageId}:${turn.outcome.settledAt}`,
      source: 'turn',
      occurredAt: turn.outcome.settledAt,
      promptMessageId: turn.promptMessageId,
      recovery: turn.outcome.recovery,
      failure: {
        ...(turn.outcome.failure ?? { category: 'internal' }),
        diagnostics: {
          ...turn.outcome.failure?.diagnostics,
          raw: turn.outcome.failure?.diagnostics.raw ?? turn.outcome.error
        }
      }
    })
  if (legacy)
    notices.push({
      id: `${prefix}:legacy:${legacy.error}`,
      source: 'turn',
      occurredAt: legacy.updatedAt ?? 0,
      failure: {
        ...(legacy.failure ?? { category: 'internal' }),
        diagnostics: {
          ...legacy.failure?.diagnostics,
          raw: legacy.failure?.diagnostics.raw ?? legacy.error
        }
      }
    })
  for (const operation of input.operations) {
    if (!operation.message) continue
    const failure =
      operation.failure ??
      classifyFailure({
        origin: operation.origin ?? 'operation',
        code: operation.code,
        text: operation.message ?? undefined
      })
    notices.push({
      id: `${prefix}:${operation.id}:${operation.occurredAt ?? ''}:${operation.message ?? ''}`,
      source: 'operation',
      operation: operation.id,
      blocksSend: operation.blocksSend || failure.reason === 'configuration/auth-failed',
      occurredAt: operation.occurredAt ?? 0,
      failure: {
        ...failure,
        diagnostics: {
          ...failure.diagnostics,
          raw:
            [operation.message, operation.detail ?? failure.diagnostics.raw]
              .filter((value, index, all) => value && all.indexOf(value) === index)
              .join('\n') || undefined
        }
      }
    })
  }
  const visible = notices.filter(
    ({ failure }) =>
      !(input.authenticationResolved && failure.reason === 'configuration/auth-failed') &&
      !(input.compacting && failure.category === 'input')
  )
  // Reconcile during render so a resolved failure can reappear without an extra effect render.
  const present = new Set(visible.map(({ id }) => id))
  const retained = [...dismissed].filter((id) => !id.startsWith(`${prefix}:`) || present.has(id))
  if (retained.length !== dismissed.size) setDismissed(new Set(retained))
  return {
    authenticationRequired: notices.some(
      (notice) => notice.failure.reason === 'configuration/auth-failed'
    ),
    notices: visible
      .filter((notice) => !dismissed.has(notice.id))
      .sort((a, b) => noticePriority(a) - noticePriority(b) || b.occurredAt - a.occurredAt),
    dismiss: (notice) => {
      if (notice.failure.category === 'session') return
      setDismissed((current) => new Set([...current, notice.id]))
    }
  }
}
