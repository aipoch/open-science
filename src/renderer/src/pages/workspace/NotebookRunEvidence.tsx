import { requestInputUpload, type InputUploadScope } from './composer-focus-events'
import { useTranslation } from 'react-i18next'
import type { NotebookRunRecord } from '../../../../shared/notebook'

// Show only evidence saved with this Run. Never substitute today's interpreter or package inventory.
export const NotebookRunEvidence = ({
  run,
  showEnvironmentCaptureWarning = true,
  uploadScope
}: {
  run: NotebookRunRecord
  showEnvironmentCaptureWarning?: boolean
  uploadScope?: InputUploadScope
}): React.JSX.Element => {
  const { t } = useTranslation()
  const target = run.frozenRuntimeTarget
  const capture = run.environmentCapture
  return (
    <details className="mt-2 text-xs text-text-300" data-testid="notebook-run-evidence">
      <summary className="cursor-pointer">{t('Execution evidence')}</summary>
      <p className="mt-1">
        {t(
          'These are saved execution facts. Executing code again uses the currently selected environment; exact reproduction is not guaranteed.'
        )}
      </p>
      {run.projectFolderInputs?.length ? (
        <div className="mt-2 space-y-1" data-testid="project-folder-input-evidence">
          <p>
            {t(
              'Inputs from the project folder are not frozen, so this run has partial provenance.'
            )}
          </p>
          {run.projectFolderInputs.map((input) => (
            <code key={input.relativePath} className="block break-all">
              {input.relativePath}
            </code>
          ))}
          {uploadScope ? (
            <button
              type="button"
              className="text-text-100 underline underline-offset-2 hover:text-text-000"
              onClick={() => requestInputUpload(uploadScope)}
            >
              {t('Add key inputs as uploads')}
            </button>
          ) : null}
        </div>
      ) : null}
      <code className="block break-all">{run.runId}</code>
      {target ? (
        <code className="block break-all">
          {target.runtimeId ?? target.environment}
          {target.interpreterPath ? ` · ${target.interpreterPath}` : ''}
        </code>
      ) : null}
      {run.environmentManifestChecksum ? (
        <code className="block break-all">{run.environmentManifestChecksum}</code>
      ) : null}
      {showEnvironmentCaptureWarning && (!capture || capture.state !== 'available') ? (
        <p>
          {t(
            'Environment evidence is incomplete or unavailable. Current packages cannot fill historical gaps.'
          )}
        </p>
      ) : null}
      {run.environmentManifest ? (
        <>
          <p>
            {t('Packages')} · {Math.min(100, run.environmentManifest.packages.length)} /{' '}
            {run.environmentManifest.packages.length}
          </p>
          {run.environmentManifest.packages.slice(0, 100).map((pkg, index) => (
            <code key={index} className="block break-all">
              {pkg.name} · {pkg.version}
            </code>
          ))}
        </>
      ) : null}
      {run.kernelEpochId ? <code className="block break-all">{run.kernelEpochId}</code> : null}
      {run.helperEvidenceStatus?.state === 'incomplete' ? (
        <p>{t('Loaded helper evidence is incomplete.')}</p>
      ) : null}
      {run.helperModules?.map((helper) => (
        <code key={helper.helperId} className="block break-all">
          {helper.helperId} · {helper.sourceDigest}
        </code>
      ))}
    </details>
  )
}
