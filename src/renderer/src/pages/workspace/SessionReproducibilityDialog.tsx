import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import type { ChatSession } from '@/stores/session-store'
import type {
  SessionReproducibilityBatch,
  SessionReproducibilityCommand
} from '../../../../shared/session-reproducibility'
import type { ProjectFileItem } from '../../../../shared/project-files'
import { formatBytes } from '../../../../shared/update'
import { listAllSessionArtifacts } from './session-artifact-download-data'

const SessionCheck = ({
  session,
  onClose
}: {
  session: ChatSession
  onClose: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [files, setFiles] = useState<ProjectFileItem[]>([])
  const [selected, setSelected] = useState(new Set<string>())
  const [batch, setBatch] = useState<SessionReproducibilityBatch>()
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const scope = useMemo(
    () => ({ projectId: session.projectId, appSessionId: session.id }),
    [session.projectId, session.id]
  )
  const polling = batch?.status === 'preparing' || batch?.status === 'running'
  useEffect(() => {
    let active = true
    void Promise.allSettled([
      window.api.artifacts.sessionReproducibility?.({ ...scope, action: 'get' }),
      listAllSessionArtifacts({
        projectId: scope.projectId,
        sessionId: scope.appSessionId,
        getOverview: window.api.projectFiles.getOverview,
        readExportFiles: window.api.projectFiles.readExportFiles,
        repairIndex: window.api.projectFiles.repairIndex
      })
    ])
      .then(
        ([state, items]) => {
          if (!active) return
          const artifacts =
            items.status === 'fulfilled'
              ? items.value.filter((item) => item.source === 'artifact')
              : []
          setBatch(state.status === 'fulfilled' ? state.value : undefined)
          setError(state.status === 'rejected' || items.status === 'rejected')
          setFiles(artifacts)
          setSelected(new Set(artifacts.slice(0, 64).map((item) => item.id)))
          setLoaded(true)
        },
        () => {
          if (active) setError(true)
        }
      )
      .finally(() => {
        if (active) setBusy(false)
      })
    return () => {
      active = false
    }
  }, [scope])
  useEffect(() => {
    if (!polling) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const state = await window.api.artifacts.sessionReproducibility?.({
          ...scope,
          action: 'get'
        })
        if (active) {
          setBatch(state)
          setError(false)
        }
      } catch {
        if (active) setError(true)
      }
      if (active) timer = setTimeout(() => void poll(), 1000)
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [batch?.batchId, polling, scope])
  const command = async (request: SessionReproducibilityCommand): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(false)
    try {
      setBatch(await window.api.artifacts.sessionReproducibility!(request))
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  const active = batch && ['preparing', 'running'].includes(batch.status)
  const status = (value: SessionReproducibilityBatch['targets'][number]['status']): string =>
    value === 'matched'
      ? t('Result reproduced')
      : value === 'different'
        ? t('Results differ')
        : value === 'failed'
          ? t('Check failed')
          : value === 'cancelled'
            ? t('Cancelled')
            : value === 'blocked'
              ? t('Unavailable')
              : value === 'running'
                ? t('Checking…')
                : value === 'queued'
                  ? t('Ready')
                  : t('Preparing…')
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[80svh] w-[min(760px,calc(100vw-2rem))] flex-col overflow-hidden p-0'
          )}
        >
          <div className="flex items-center justify-between gap-3 border-b border-border-300 px-5 py-3">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold">
                {t('Check session artifacts')}
              </Dialog.Title>
              <Dialog.Description className="truncate text-xs text-text-300">
                {session.title}
              </Dialog.Description>
            </div>
            <Button variant="ghost" size="icon" aria-label={t('Close')} onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
          <div className="overflow-y-auto px-5 py-4">
            <p className="mb-3 text-xs text-text-300">
              {t(
                'Each selected version is checked independently from its captured inputs. Closing this dialog keeps the checks running.'
              )}
            </p>
            {error ? (
              <p
                role="alert"
                className="mb-3 text-xs text-status-warning-foreground dark:text-status-warning-dark-foreground"
              >
                {t('Session checks could not be loaded or started. Reopen this dialog to retry.')}
              </p>
            ) : null}
            {!loaded ? (
              <p role="status" className="text-xs">
                {t('Loading…')}
              </p>
            ) : batch ? (
              <>
                <p className="mb-3 text-xs tabular-nums" role="status">
                  {t('Check progress: {{done}} / {{total}}', {
                    done: batch.targets.filter((row) =>
                      ['matched', 'different', 'failed', 'blocked', 'cancelled'].includes(
                        row.status
                      )
                    ).length,
                    total: batch.targets.length
                  })}
                </p>
                <ul className="divide-y divide-border-300/60">
                  {batch.targets.map((row) => (
                    <li key={`${row.artifactId}:${row.versionId}`} className="py-2">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="truncate" title={row.name}>
                          {row.name}
                        </span>
                        <span className="shrink-0 text-xs text-text-200">{status(row.status)}</span>
                      </div>
                      {row.status === 'blocked' ? (
                        <p className="mt-1 text-xs text-text-300">
                          {row.reason === 'environment-transition'
                            ? t(
                                'These runs changed dependencies in one kernel. Capture a new version in a fixed environment.'
                              )
                            : row.reason === 'insufficient-disk-space'
                              ? t('Free more disk space before checking these inputs.')
                              : t(
                                  'Saved code, inputs or environment locks could not be verified. View this version’s Reproducibility details.'
                                )}
                        </p>
                      ) : null}
                      {row.steps !== undefined ? (
                        <p className="mt-1 text-xs text-text-300">
                          {t('Runs to execute')} {row.steps} · {t('Frozen files')}{' '}
                          {formatBytes(row.inputBytes ?? 0)} · {t('Environment')}{' '}
                          {row.environmentCount}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <p className="mb-2 text-xs text-text-300">
                  {t('Select up to 64 Artifact Versions per batch.')}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setSelected(
                      selected.size ? new Set() : new Set(files.slice(0, 64).map((f) => f.id))
                    )
                  }
                >
                  {selected.size ? t('Clear selection') : t('Select all')}
                </Button>
                <ul className="divide-y divide-border-300/60">
                  {files.map((file) => (
                    <li key={file.id}>
                      <label className="flex items-center gap-2 py-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selected.has(file.id)}
                          disabled={!selected.has(file.id) && selected.size >= 64}
                          onChange={() =>
                            setSelected((current) => {
                              const next = new Set(current)
                              if (next.has(file.id)) next.delete(file.id)
                              else next.add(file.id)
                              return next
                            })
                          }
                        />
                        <span className="min-w-0 flex-1 truncate" title={file.name}>
                          {file.name}
                        </span>
                        <span className="text-xs text-text-300">{formatBytes(file.size)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-border-300 px-5 py-3">
            {active ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void command({ ...scope, action: 'cancel', batchId: batch.batchId })}
              >
                {t('Cancel')}
              </Button>
            ) : batch ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setBatch(undefined)}
                >
                  {t('Change selection')}
                </Button>
                {batch.status === 'ready' ? (
                  <Button
                    size="sm"
                    disabled={busy || !batch.targets.some((row) => row.status === 'queued')}
                    onClick={() =>
                      void command({ ...scope, action: 'start', batchId: batch.batchId })
                    }
                  >
                    {t('Check reproducibility')}
                  </Button>
                ) : null}
              </>
            ) : (
              <Button
                size="sm"
                disabled={busy || !loaded || !selected.size}
                onClick={() =>
                  void command({
                    ...scope,
                    action: 'prepare',
                    targets: files
                      .filter((f) => selected.has(f.id))
                      .map((f) => ({
                        artifactId: f.sourceFileId,
                        versionId: f.sourceVersionId,
                        name: f.name
                      }))
                  })
                }
              >
                {busy ? t('Preparing…') : t('Check readiness')}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export const SessionReproducibilityDialog = ({
  session,
  onClose
}: {
  session?: ChatSession
  onClose: () => void
}): React.JSX.Element | null =>
  session ? (
    <SessionCheck key={`${session.projectId}:${session.id}`} session={session} onClose={onClose} />
  ) : null
