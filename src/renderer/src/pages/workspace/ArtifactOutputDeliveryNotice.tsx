import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import type {
  ArtifactOutputDeliveryStatus,
  ManagedFileIdentity
} from '../../../../shared/managed-file-versions'

/** A saved immutable version and its ordinary project file have separate outcomes. */
export const ArtifactOutputDeliveryNotice = ({
  identity,
  delivery,
  onUpdated
}: {
  identity: ManagedFileIdentity
  delivery: ArtifactOutputDeliveryStatus
  onUpdated: () => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [retryError, setRetryError] = useState<string>()
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const canRetry =
    delivery.canRetry && typeof window.api.managedFileVersions.retryOutputDelivery === 'function'
  if (delivery.state === 'delivered' || delivery.state === 'cancelled') return null
  const retry = async (): Promise<void> => {
    if (inFlight.current || !canRetry) return
    inFlight.current = true
    setBusy(true)
    setRetryError(undefined)
    try {
      const result = await window.api.managedFileVersions.retryOutputDelivery({
        ...identity,
        versionId: delivery.versionId
      })
      if (!mounted.current) return
      if (!result.ok) setRetryError(result.error.code)
      else onUpdated()
    } catch {
      if (mounted.current) setRetryError('OUTPUT_DELIVERY_FAILED')
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <div className="max-h-64 shrink-0 overflow-y-auto border-b border-border-300/50 p-3">
      <ErrorNotice
        role="status"
        level="warning"
        title={t('Version saved; project file needs attention')}
        description={
          retryError
            ? t(
                'The project file could not be updated. The saved version is still available. Try again when the folder is accessible.'
              )
            : delivery.state === 'conflict'
              ? t(
                  'The project file has changed outside the app. Review the replacement before updating it.'
                )
              : t(
                  'The saved version is available, but its current copy has not been delivered to the project folder.'
                )
        }
        content={<p className="break-all font-mono text-xs">{delivery.relativePath}</p>}
        errorCode={retryError ?? delivery.errorCode}
        diagnosticsLabel={t('Diagnostics')}
        primaryButton={
          canRetry
            ? {
                label: t('Update project file'),
                onClick: () => void retry(),
                loading: busy
              }
            : undefined
        }
      />
    </div>
  )
}
