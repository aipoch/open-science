import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ArtifactReproducibilityOutputStorage,
  ArtifactReproducibilityReceiptScope
} from '../../../../shared/artifact-reproducibility'
import { formatBytes } from '../../../../shared/update'
import { Button } from '../../components/ui/button'

import { ReproducibilityOutputStorageContext as StorageContext } from './reproducibility-output-storage-context'

const STORAGE_CHANGED = 'reproducibility-output-storage-changed'

export const ReproducibilityOutputStorage = ({
  scope: requestedScope,
  receiptKey,
  running,
  readOnly = false,
  children
}: {
  scope?: ArtifactReproducibilityReceiptScope
  receiptKey: string
  running: boolean
  readOnly?: boolean
  children: ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  const projectId = requestedScope?.projectId
  const appSessionId = requestedScope?.appSessionId
  const artifactId = requestedScope?.artifactId
  const versionId = requestedScope?.versionId
  const scope = useMemo(
    () =>
      projectId && appSessionId && artifactId && versionId
        ? { projectId, appSessionId, artifactId, versionId }
        : undefined,
    [projectId, appSessionId, artifactId, versionId]
  )
  const [storage, setStorage] = useState<ArtifactReproducibilityOutputStorage>()
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string>()
  const [revision, setRevision] = useState(0)
  const busy = useRef(false)
  const generation = useRef(0)
  const available = Boolean(scope && window.api?.artifacts.getReproducibilityOutputStorage)
  useEffect(() => {
    if (!scope || !window.api?.artifacts.getReproducibilityOutputStorage) return
    let active = true
    const load = (): void => {
      const current = ++generation.current
      void window.api.artifacts.getReproducibilityOutputStorage!(scope).then(
        (value) => {
          if (active && current === generation.current) {
            setStorage(value)
            setError(undefined)
          }
        },
        () => {
          if (active && current === generation.current)
            setError(t('Output storage could not be loaded.'))
        }
      )
    }
    load()
    window.addEventListener(STORAGE_CHANGED, load)
    return () => {
      active = false
      window.removeEventListener(STORAGE_CHANGED, load)
    }
  }, [scope, receiptKey, revision, t])
  const clear = async (): Promise<void> => {
    if (
      !scope ||
      !window.api.artifacts.clearReproducibilityOutputs ||
      busy.current ||
      running ||
      readOnly
    )
      return
    busy.current = true
    ++generation.current
    setClearing(true)
    setError(undefined)
    try {
      const result = await window.api.artifacts.clearReproducibilityOutputs(scope)
      setStorage(result)
      setConfirming(false)
      window.dispatchEvent(new Event(STORAGE_CHANGED))
    } catch {
      setError(t('Reproduced outputs could not be cleared.'))
    } finally {
      busy.current = false
      setClearing(false)
    }
  }
  return (
    <StorageContext.Provider value={storage}>
      {available && (!storage || storage.fileCount > 0 || error) ? (
        <div
          data-reproducibility-output-storage
          className="space-y-2 border-b border-border-300/50 px-3.5 py-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <p className="text-text-200">
              {t('Retained reproduced outputs')}
              {storage ? (
                <>
                  {' '}
                  <span className="font-medium tabular-nums">{formatBytes(storage.sizeBytes)}</span>
                  <span className="text-text-300">
                    {' · '}
                    {t('{{count}} files', {
                      count: storage.fileCount,
                      defaultValue_one: '{{count}} file'
                    })}
                  </span>
                </>
              ) : (
                <>
                  {' '}
                  {' · '}
                  {t('Loading…')}
                </>
              )}
            </p>
            {storage &&
            !readOnly &&
            storage.fileCount > 0 &&
            window.api.artifacts.clearReproducibilityOutputs ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={running || clearing}
                onClick={() => setConfirming(true)}
              >
                {t('Clear reproduced outputs')}
              </Button>
            ) : null}
          </div>
          {confirming && storage ? (
            <div
              role="group"
              aria-label={t('Clear reproduced outputs')}
              className="space-y-2 rounded-md border border-border-300/60 bg-bg-100 p-3"
            >
              <p className="text-xs leading-5 text-text-200">
                {t(
                  'Clear {{size}} of reproduced outputs for this version? Verification history and logs are kept.',
                  { size: formatBytes(storage.sizeBytes) }
                )}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={clearing}
                  onClick={() => setConfirming(false)}
                >
                  {t('Cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={clearing || running}
                  onClick={() => void clear()}
                >
                  {clearing ? t('Clearing…') : t('Clear')}
                </Button>
              </div>
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="flex items-center gap-2 text-xs text-text-200">
              <p>{error}</p>
              {!storage ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setRevision((value) => value + 1)}
                >
                  {t('Retry')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
    </StorageContext.Provider>
  )
}
