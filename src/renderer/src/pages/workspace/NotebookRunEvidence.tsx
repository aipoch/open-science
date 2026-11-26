import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NotebookRunRecord, NotebookRunEvidenceSnapshot } from '../../../../shared/notebook'

// Show only evidence saved with this Run. Never substitute today's interpreter or package inventory.
export const NotebookRunEvidence = ({
  run,
  showEnvironmentCaptureWarning = true,
  loadRun
}: {
  run: NotebookRunRecord
  showEnvironmentCaptureWarning?: boolean
  loadRun?: (runId: string) => Promise<NotebookRunEvidenceSnapshot | null | undefined>
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [evidenceRun, setEvidenceRun] = useState<
    NotebookRunEvidenceSnapshot & Pick<NotebookRunRecord, 'frozenRuntimeTarget' | 'helperModules'>
  >()
  const [isLoading, setIsLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const displayedRun = evidenceRun ?? run
  const target = displayedRun.frozenRuntimeTarget
  const capture = displayedRun.environmentCapture
  const environmentManifestChecksum =
    displayedRun.environmentManifestChecksum ??
    (capture?.state === 'available' || capture?.state === 'partial'
      ? capture.manifestChecksum
      : undefined)
  const loadEvidence = async (): Promise<void> => {
    if (
      evidenceRun ||
      isLoading ||
      !loadRun ||
      displayedRun.environmentManifest ||
      !environmentManifestChecksum
    )
      return
    setIsLoading(true)
    setLoadFailed(false)
    try {
      const loaded = await loadRun(displayedRun.runId)
      if (loaded?.environmentManifest) setEvidenceRun(loaded)
      else setLoadFailed(true)
    } catch {
      setLoadFailed(true)
    } finally {
      setIsLoading(false)
    }
  }
  return (
    <details
      className="mt-2 text-xs text-text-300"
      data-testid="notebook-run-evidence"
      onToggle={(event) => {
        setIsOpen(event.currentTarget.open)
        if (event.currentTarget.open) void loadEvidence()
      }}
    >
      <summary className="cursor-pointer">{t('Execution evidence')}</summary>
      <p className="mt-1">
        {t(
          'These are saved execution facts. Executing code again uses the currently selected environment; exact reproduction is not guaranteed.'
        )}
      </p>
      <code className="block break-all">{displayedRun.runId}</code>
      {target ? (
        <code className="block break-all">
          {target.runtimeId ?? target.environment}
          {target.interpreterPath ? ` · ${target.interpreterPath}` : ''}
        </code>
      ) : null}
      {environmentManifestChecksum ? (
        <code className="block break-all">{environmentManifestChecksum}</code>
      ) : null}
      {showEnvironmentCaptureWarning && (!capture || capture.state !== 'available') ? (
        <p>
          {t(
            'Environment evidence is incomplete or unavailable. Current packages cannot fill historical gaps.'
          )}
        </p>
      ) : null}
      {isLoading ? <p>{t('Loading…')}</p> : null}
      {loadFailed ? (
        <p>
          {t(
            'Environment evidence is incomplete or unavailable. Current packages cannot fill historical gaps.'
          )}
        </p>
      ) : null}
      {isOpen && displayedRun.environmentManifest ? (
        <>
          <p>
            {t('Packages')} · {Math.min(100, displayedRun.environmentManifest.packages.length)} /{' '}
            {displayedRun.environmentManifest.packages.length}
          </p>
          {displayedRun.environmentManifest.packages.slice(0, 100).map((pkg, index) => (
            <code key={index} className="block break-all">
              {pkg.name} · {pkg.version}
            </code>
          ))}
        </>
      ) : null}
      {displayedRun.kernelEpochId ? (
        <code className="block break-all">{displayedRun.kernelEpochId}</code>
      ) : null}
      {displayedRun.helperEvidenceStatus?.state === 'incomplete' ? (
        <p>{t('Loaded helper evidence is incomplete.')}</p>
      ) : null}
      {displayedRun.helperModules?.map((helper) => (
        <code key={helper.helperId} className="block break-all">
          {helper.helperId} · {helper.sourceDigest}
        </code>
      ))}
    </details>
  )
}
