import { useContext, useEffect, useState } from 'react'
import { OutputComparisonDetails } from './OutputComparison'
import { useTranslation } from 'react-i18next'
import type {
  ArtifactReproducibilityReceipt,
  ArtifactReproducibilityReceiptComparison,
  ArtifactReproducibilityOutputPreview,
  ReproducibilityOutputPreview
} from '../../../../shared/artifact-reproducibility'
import { Button } from '../../components/ui/button'
import { formatBytes } from '../../../../shared/update'
import { ReproducibilityOutputStorageContext } from './reproducibility-output-storage-context'

const OutputPreview = ({
  value,
  label
}: {
  value?: ReproducibilityOutputPreview
  label: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <figure className="min-w-0 rounded-md border border-border-300/60 p-3">
      <figcaption className="mb-2 text-xs font-medium text-text-200">{label}</figcaption>
      {value?.kind === 'image' ? (
        <img src={value.dataUrl} alt={label} className="max-h-80 w-full object-contain" />
      ) : value?.kind === 'text' ? (
        <>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
            {value.text}
          </pre>
          {value.truncated ? (
            <p className="mt-2 text-xs text-text-300">
              {t('Preview truncated. Download the full output.')}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-text-300">{t('Preview unavailable.')}</p>
      )}
    </figure>
  )
}

const ReproducibilityOutputContent = ({
  receipt,
  comparison,
  cleared
}: {
  receipt: ArtifactReproducibilityReceipt
  comparison: ArtifactReproducibilityReceiptComparison
  cleared: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [preview, setPreview] = useState<ArtifactReproducibilityOutputPreview>()
  const [error, setError] = useState<string>()
  const [downloading, setDownloading] = useState(false)
  const [overlayOpacity, setOverlayOpacity] = useState(50)
  const scope = receipt.artifactVersion
  useEffect(() => {
    if (cleared || !expanded || preview || !window.api.artifacts.readReproducibilityOutput) return
    let active = true
    void window.api.artifacts
      .readReproducibilityOutput({
        projectId: scope.projectId,
        appSessionId: scope.appSessionId,
        artifactId: scope.artifactId,
        versionId: scope.versionId,
        receiptChecksum: receipt.receiptChecksum,
        entityId: comparison.entityId
      })
      .then(
        (value) => {
          if (active) setPreview(value)
        },
        () => {
          if (active) setError(t('Reproduced output could not be loaded.'))
        }
      )
    return () => {
      active = false
    }
  }, [cleared, expanded, preview, scope, receipt.receiptChecksum, comparison.entityId, t])
  const download = async (): Promise<void> => {
    if (!window.api.artifacts.exportReproducibilityReceipt || downloading) return
    setDownloading(true)
    setError(undefined)
    try {
      await window.api.artifacts.exportReproducibilityReceipt({
        projectId: scope.projectId,
        appSessionId: scope.appSessionId,
        artifactId: scope.artifactId,
        versionId: scope.versionId,
        receiptChecksum: receipt.receiptChecksum,
        suggestedName: comparison.relativePath,
        outputEntityId: comparison.entityId
      })
    } catch {
      setError(t('Reproduced output could not be downloaded.'))
    } finally {
      setDownloading(false)
    }
  }
  return (
    <div className="@container mt-2 min-w-0" data-reproduced-output={comparison.entityId}>
      {comparison.status === 'different' ? (
        <p className="text-xs text-text-300">
          {comparison.reason === 'missing'
            ? t('Output file was not generated.')
            : comparison.reason === 'size-mismatch'
              ? t('File size differs.')
              : comparison.reason === 'checksum-mismatch'
                ? t('File contents differ.')
                : t('Output file could not be compared.')}
        </p>
      ) : null}
      {comparison.contentComparison ? (
        <OutputComparisonDetails report={comparison.contentComparison} />
      ) : comparison.contentComparisonUnavailableReason ? (
        <p className="mt-2 text-xs text-text-300">
          {t('Content comparison unavailable')}
          {': '}
          {comparison.contentComparisonUnavailableReason === 'budget-exceeded'
            ? t('Content exceeds the comparison limit.')
            : comparison.contentComparisonUnavailableReason === 'unsupported-format'
              ? t('This content format is not supported for comparison.')
              : t('Content could not be parsed or compared.')}
        </p>
      ) : null}
      {comparison.actualSizeBytes !== undefined && !cleared ? (
        <p className="mt-1 text-xs tabular-nums text-text-300">
          {formatBytes(comparison.actualSizeBytes)}
        </p>
      ) : null}
      {cleared ? (
        <p className="mt-1 text-xs text-text-300">{t('Output cleared')}</p>
      ) : comparison.outputCaptured ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {window.api.artifacts.readReproducibilityOutput ? (
            <Button
              size="sm"
              variant="outline"
              aria-expanded={expanded}
              onClick={() => {
                setExpanded(!expanded)
                setError(undefined)
              }}
            >
              {expanded ? t('Hide output') : t('View output')}
            </Button>
          ) : null}
          {window.api.artifacts.exportReproducibilityReceipt ? (
            <Button
              size="sm"
              variant="outline"
              disabled={downloading}
              onClick={() => void download()}
            >
              {downloading ? t('Downloading…') : t('Download output')}
            </Button>
          ) : null}
        </div>
      ) : comparison.status === 'different' && comparison.reason !== 'missing' ? (
        <p className="mt-1 text-xs text-text-300">
          {comparison.outputCaptureReason === 'too-large'
            ? t('Output exceeds the 32 MB retention limit.')
            : comparison.outputCaptureReason === 'storage-limit'
              ? t('Output retention limit reached.')
              : t('Reproduced output was not retained.')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-text-200">
          {error}
        </p>
      ) : null}
      {expanded && !cleared && !error ? (
        preview ? (
          <div className="mt-3 grid grid-cols-1 gap-3 @lg:grid-cols-2">
            <OutputPreview label={t('Original output')} value={preview.original} />
            <OutputPreview label={t('Reproduced output')} value={preview.reproduced} />
            {preview.original?.kind === 'image' &&
            preview.reproduced?.kind === 'image' &&
            comparison.contentComparison?.image ? (
              <figure className="min-w-0 rounded-md border border-border-300/60 p-3">
                <figcaption className="mb-2 text-xs font-medium text-text-200">
                  {t('Image overlay')}
                </figcaption>
                <div className="relative">
                  <img
                    src={preview.original.dataUrl}
                    alt={t('Original output')}
                    className="max-h-80 w-full object-contain"
                  />
                  <img
                    src={preview.reproduced.dataUrl}
                    alt={t('Reproduced output')}
                    className="absolute inset-0 h-full w-full object-contain"
                    style={{ opacity: overlayOpacity / 100 }}
                  />
                </div>
                <label className="mt-2 flex items-center gap-2 text-xs text-text-300">
                  {t('Reproduced output')}
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={overlayOpacity}
                    onChange={(event) => setOverlayOpacity(Number(event.target.value))}
                    className="min-w-0 flex-1"
                  />
                  <span className="tabular-nums">{overlayOpacity}%</span>
                </label>
              </figure>
            ) : null}
            {preview.differenceImage ? (
              <OutputPreview
                label={t('Difference image')}
                value={{ kind: 'image', dataUrl: preview.differenceImage }}
              />
            ) : null}
          </div>
        ) : (
          <p role="status" className="mt-2 text-xs text-text-300">
            {t('Loading…')}
          </p>
        )
      ) : null}
    </div>
  )
}

export const ReproducibilityOutput = (props: {
  receipt: ArtifactReproducibilityReceipt
  comparison: ArtifactReproducibilityReceiptComparison
}): React.JSX.Element => {
  const cleared =
    useContext(ReproducibilityOutputStorageContext)?.clearedReceiptChecksums.includes(
      props.receipt.receiptChecksum
    ) ?? false
  return (
    <ReproducibilityOutputContent
      key={`${props.receipt.receiptChecksum}:${props.comparison.entityId}:${cleared}`}
      {...props}
      cleared={cleared}
    />
  )
}
