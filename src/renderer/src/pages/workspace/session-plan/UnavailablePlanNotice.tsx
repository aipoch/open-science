import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import type { PlanResponseIdentity } from '../../../../../shared/session-plan/contract'
import { ErrorNotice } from '@/components/error-notice'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import type { ChatSession } from '@/stores/session-store'

const UnavailablePlanNotice = ({ session }: { session: ChatSession }): React.JSX.Element => {
  const { t } = useTranslation()
  const [confirmation, setConfirmation] = useState<PlanResponseIdentity>()
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string>()
  const inFlight = useRef(false)
  const context = session.runtimeContext
  const artifactVersionId = context?.plan?.artifactVersionId
  const revision = context?.revision
  const canDiscard =
    typeof artifactVersionId === 'string' &&
    typeof revision === 'number' &&
    typeof window.api.acp.discardUnavailablePlan === 'function'
  const discard = async (): Promise<void> => {
    if (!confirmation || inFlight.current) return
    inFlight.current = true
    setLoading(true)
    setError(undefined)
    try {
      await window.api.acp.discardUnavailablePlan(confirmation)
      setConfirmation(undefined)
      setSubmitted(true)
      // The existing durable Session subscription and projection retry own the refresh.
    } catch (cause) {
      setConfirmation(undefined)
      setError(cause instanceof Error ? cause.message : t('Unable to discard the Plan.'))
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }
  return (
    <div
      role="alert"
      className="mb-2 [&>section]:max-w-none [&>section]:items-start [&>section]:gap-2 [&>section>svg]:hidden [&_h1]:text-xs"
    >
      <ErrorNotice
        icon={AlertTriangle}
        tone="amber"
        title={t('Unable to restore plan state. Retrying…')}
        description={error}
        primaryButton={
          canDiscard
            ? {
                label: t('Discard unavailable Plan'),
                disabled: submitted,
                loading,
                onClick: () =>
                  setConfirmation({
                    projectId: session.projectId,
                    sessionId: session.id,
                    artifactVersionId,
                    expectedRevision: revision
                  })
              }
            : undefined
        }
      />
      <ConfirmActionDialog
        open={confirmation !== undefined}
        title={t('Discard unavailable Plan?')}
        description={t(
          'This removes the active Plan and its approval and progress from this conversation. Messages and Artifacts are kept. This cannot be undone.'
        )}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Discard unavailable Plan')}
        loading={loading}
        destructive
        onCancel={() => setConfirmation(undefined)}
        onConfirm={() => void discard()}
      />
    </div>
  )
}

export { UnavailablePlanNotice }
