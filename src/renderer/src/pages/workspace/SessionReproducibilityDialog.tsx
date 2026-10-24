import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import {
  assertDesktopRuntimeWrite,
  getDesktopRuntimeEpoch,
  useDesktopRuntimeRecoveryStore
} from '@/stores/desktop-runtime-recovery-store'
import type { ArtifactReproducibilityReceipt } from '../../../../shared/artifact-reproducibility'
import { ReproducibilityOutput } from './ReproducibilityOutput'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import type { ChatSession } from '@/stores/session-store-contract'
import type {
  SessionReproducibilityBatch,
  SessionReproducibilityCommand
} from '../../../../shared/session-reproducibility'
import type { ProjectFileItem } from '../../../../shared/project-files'
import type {
  ArtifactReproducibilityProjection,
  ArtifactWorkflowProjection,
  GetArtifactVersionProvenanceRequest
} from '../../../../shared/artifact-provenance'
import { unwrapProvenanceRead } from '../../../../shared/provenance-read-result'
import { formatBytes } from '../../../../shared/update'
import { listAllSessionArtifacts } from './session-artifact-download-data'
import {
  findStepReproductionTarget,
  isStepReproductionBatch,
  type StepReproductionTarget
} from './step-reproduction-target'

type WorkflowSelection = NonNullable<SessionReproducibilityBatch['targets'][number]['workflow']>
type RenderStepInputFiles = (inputFiles: StepReproductionTarget['inputFiles']) => React.ReactNode

const StepOutputs = ({
  request,
  receiptChecksum
}: {
  request: GetArtifactVersionProvenanceRequest
  receiptChecksum: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [receipt, setReceipt] = useState<ArtifactReproducibilityReceipt>()
  const [error, setError] = useState(false)
  const { projectId, appSessionId, artifactId, versionId } = request
  useEffect(() => {
    let active = true
    const readReceipt = async (): Promise<void> => {
      const read = window.api.artifacts.listReproducibilityReceipts
      if (!read) throw new Error('Receipt history is unavailable')
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const page = await read({
          projectId,
          appSessionId,
          artifactId,
          versionId,
          ...(cursor ? { cursor } : {})
        })
        if (!active) return
        const exact = page.receipts.find(
          (value) =>
            value.receiptChecksum === receiptChecksum &&
            value.artifactVersion.projectId === projectId &&
            value.artifactVersion.appSessionId === appSessionId &&
            value.artifactVersion.artifactId === artifactId &&
            value.artifactVersion.versionId === versionId
        )
        if (exact) {
          setReceipt(exact)
          return
        }
        cursor = page.nextCursor
        if (cursor && seen.has(cursor)) break
        if (cursor) seen.add(cursor)
      } while (cursor)
      if (active) setError(true)
    }
    void readReceipt().catch(() => {
      if (active) setError(true)
    })
    return () => {
      active = false
    }
  }, [projectId, appSessionId, artifactId, versionId, receiptChecksum])
  return (
    <div className="mt-2 space-y-2">
      {receipt?.comparisons.map((comparison) => (
        <ReproducibilityOutput
          key={comparison.entityId}
          receipt={receipt}
          scope={request}
          comparison={comparison}
        />
      ))}
      {error ? <ErrorNotice inline description={t('Preview unavailable.')} /> : null}
    </div>
  )
}

// Read checkpoint metadata only on demand. Main revalidates the selected frozen files at preflight
// and execution; a failed read must never replace the user's selection with an earlier start.
const StartingPoint = ({
  request,
  name,
  frontierId = 'original-inputs',
  disabled,
  workflow,
  onWorkflowChange,
  onChange
}: {
  request: GetArtifactVersionProvenanceRequest
  name: string
  frontierId?: string
  disabled?: boolean
  workflow?: WorkflowSelection
  onWorkflowChange?: (workflow: WorkflowSelection) => void
  onChange?: (frontierId: string) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [requested, setRequested] = useState(frontierId !== 'original-inputs')
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState<{
    projection?: ArtifactReproducibilityProjection
    workflow?: ArtifactWorkflowProjection
    error?: boolean
  }>()
  const { projectId, appSessionId, artifactId, versionId } = request
  useEffect(() => {
    if (!requested) return
    let active = true
    void window.api.artifacts
      .getVersionExecution({ projectId, appSessionId, artifactId, versionId })
      .then(unwrapProvenanceRead)
      .then(
        (value) => {
          if (active)
            setResult({
              projection: value.execution?.reproducibility,
              workflow: value.execution?.workflow
            })
        },
        () => {
          if (active) setResult({ error: true })
        }
      )
    return () => {
      active = false
    }
  }, [requested, retry, projectId, appSessionId, artifactId, versionId])
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const captured = result?.workflow?.state === 'available' ? result.workflow : undefined
  const workflowMode = frontierId === 'workflow-selection'
  const projection = result?.projection
  const activities = new Map(
    projection?.activities.map((activity) => [activity.activityId, activity])
  )
  const computeNumbers = new Map(
    (projection?.activities ?? [])
      .filter((activity) => activity.kind === 'compute-job')
      .map((activity, index) => [activity.activityId, index + 1])
  )
  const checkpoints = (projection?.startFrontiers ?? []).filter(
    (frontier) =>
      frontier.kind === 'checkpoint' &&
      frontier.eligibility === 'available' &&
      !frontier.unavailableEntityIds?.length &&
      frontier.crossingEntityIds.every((id) =>
        projection?.entities.some((entity) => entity.entityId === id)
      ) &&
      frontier.downstreamActivityIds.every((id) => activities.has(id)) &&
      frontier.downstreamActivityIds.some((id) =>
        ['notebook-run', 'compute-job'].includes(activities.get(id)!.kind)
      )
  )
  const choices = checkpoints.map((frontier) => {
    const activity = frontier.afterActivityId ? activities.get(frontier.afterActivityId) : undefined
    const label = t('After {{activity}}', {
      activity:
        activity?.kind === 'compute-job'
          ? t('Compute job {{number}}', { number: computeNumbers.get(activity.activityId) ?? 1 })
          : activity?.runIndex !== undefined
            ? t('Notebook run {{number}}', { number: activity.runIndex + 1 })
            : t('captured activity')
    })
    return { frontier, label }
  })
  const label =
    frontierId === 'original-inputs'
      ? t('Original captured inputs')
      : workflowMode
        ? t('Workflow stages')
        : (choices.find((choice) => choice.frontier.frontierId === frontierId)?.label ??
          t('Saved intermediate results'))
  return (
    <div className="mt-2 space-y-1 text-xs text-text-300">
      {onChange && (choices.length > 0 || captured) ? (
        <Select
          value={frontierId}
          onValueChange={(value) => {
            if (value === 'workflow-selection' && captured && !workflow)
              onWorkflowChange?.({
                captureId: captured.captureId,
                targetRunIds: captured.stages.slice(-1).map((stage) => stage.runId),
                boundaryEntityIds: []
              })
            onChange(value)
          }}
          disabled={disabled}
        >
          <SelectTrigger aria-label={t('Starting point for {{name}}', { name })} className="h-8">
            <SelectValue placeholder={label} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="original-inputs">{t('Original captured inputs')}</SelectItem>
            {captured ? (
              <SelectItem value="workflow-selection">{t('Workflow stages')}</SelectItem>
            ) : null}
            {choices.map(({ frontier, label: choiceLabel }) => (
              <SelectItem key={frontier.frontierId} value={frontier.frontierId}>
                {choiceLabel} ·{' '}
                {t('Runs to execute: {{runs}}', {
                  runs: frontier.downstreamActivityIds.filter((id) =>
                    ['notebook-run', 'compute-job'].includes(activities.get(id)!.kind)
                  ).length
                })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p>
          {t('Start from')} · {label}
        </p>
      )}
      {workflowMode ? (
        <fieldset
          disabled={disabled || !onWorkflowChange}
          className="space-y-2 rounded-md border border-border p-2"
        >
          <legend>{t('Captured stages through this Artifact Version')}</legend>
          <p>
            {t(
              'Select any captured runs or choose a continuous range. Required upstream runs are added during readiness checks.'
            )}
          </p>
          {captured ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {[
                  {
                    label: t('First captured stage'),
                    value: rangeStart,
                    change: setRangeStart,
                    fallback: captured.stages[0]?.runId
                  },
                  {
                    label: t('Last captured stage'),
                    value: rangeEnd,
                    change: setRangeEnd,
                    fallback: captured.stages.at(-1)?.runId
                  }
                ].map(({ label: rangeLabel, value, change, fallback }) => (
                  <label key={rangeLabel} className="flex items-center gap-1">
                    {rangeLabel}
                    <select
                      aria-label={rangeLabel}
                      value={value || fallback}
                      onChange={(event) => change(event.target.value)}
                      className="rounded-md border border-input bg-background p-1 text-foreground"
                    >
                      {captured.stages.map((stage) => (
                        <option key={stage.runId} value={stage.runId}>
                          {t('Notebook run {{number}}', { number: stage.runIndex + 1 })}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!captured.stages.length}
                  onClick={() => {
                    const first = captured.stages.findIndex(
                      (stage) => stage.runId === (rangeStart || captured.stages[0]?.runId)
                    )
                    const last = captured.stages.findIndex(
                      (stage) => stage.runId === (rangeEnd || captured.stages.at(-1)?.runId)
                    )
                    const selectedStages = captured.stages.slice(
                      Math.min(first, last),
                      Math.max(first, last) + 1
                    )
                    onWorkflowChange?.({
                      captureId: captured.captureId,
                      boundaryEntityIds: workflow?.boundaryEntityIds ?? [],
                      targetRunIds: selectedStages.map((stage) => stage.runId)
                    })
                  }}
                >
                  {t('Select range')}
                </Button>
              </div>
              {captured.stages.map((stage) => (
                <label key={stage.runId} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={workflow?.targetRunIds.includes(stage.runId) ?? false}
                    onChange={() => {
                      const selectedRuns = new Set(workflow?.targetRunIds)
                      if (selectedRuns.has(stage.runId)) selectedRuns.delete(stage.runId)
                      else selectedRuns.add(stage.runId)
                      const selectedStages = captured.stages.filter((row) =>
                        selectedRuns.has(row.runId)
                      )
                      onWorkflowChange?.({
                        captureId: captured.captureId,
                        targetRunIds: selectedStages.map((row) => row.runId),
                        boundaryEntityIds: workflow?.boundaryEntityIds ?? []
                      })
                    }}
                  />
                  {t('Notebook run {{number}}', { number: stage.runIndex + 1 })} ·{' '}
                  {stage.kernelKind}
                </label>
              ))}
              {!workflow?.targetRunIds.length ? (
                <p role="alert">{t('Select at least one captured stage.')}</p>
              ) : null}
              {captured.boundaries.length ? (
                <fieldset className="space-y-1">
                  <legend>{t('Frozen boundary files')}</legend>
                  <p>{t('Reuse selected frozen files instead of rerunning their producers.')}</p>
                  {captured.boundaries.map((boundary) => (
                    <label key={boundary.entityId} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={workflow?.boundaryEntityIds?.includes(boundary.entityId) ?? false}
                        onChange={() => {
                          const selectedFiles = new Set(workflow?.boundaryEntityIds)
                          if (selectedFiles.has(boundary.entityId))
                            selectedFiles.delete(boundary.entityId)
                          else selectedFiles.add(boundary.entityId)
                          if (workflow)
                            onWorkflowChange?.({
                              ...workflow,
                              boundaryEntityIds: [...selectedFiles]
                            })
                        }}
                      />
                      <span className="break-all">{boundary.relativePath}</span> ·{' '}
                      {formatBytes(boundary.sizeBytes)}
                    </label>
                  ))}
                </fieldset>
              ) : null}
            </>
          ) : result && !result.error ? (
            <p>{t('Captured workflow stages are unavailable for this version.')}</p>
          ) : null}
        </fieldset>
      ) : (
        <p>
          {frontierId === 'original-inputs' ? t('End-to-end claim') : t('Downstream-only claim')}
        </p>
      )}
      {(onChange && !requested) || result?.error ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={t('Starting point for {{name}}', { name })}
          onClick={() => {
            setResult(undefined)
            setRequested(true)
            setRetry((value) => value + 1)
          }}
        >
          {result?.error ? t('Retry') : t('Start from')}
        </Button>
      ) : null}
      {requested && !result ? <p role="status">{t('Loading…')}</p> : null}
      {result?.error ? (
        <p role="alert">{t('Starting points could not be loaded. Try again.')}</p>
      ) : onChange && result && !choices.length ? (
        <p>{t('No saved intermediate results are available for this version.')}</p>
      ) : null}
      {frontierId !== 'original-inputs' && !workflowMode ? (
        <p>
          {t(
            'Reuse saved intermediate results and rerun only downstream steps. Upstream steps are not checked.'
          )}
        </p>
      ) : null}
    </div>
  )
}

const SessionCheck = ({
  session,
  run,
  disabled,
  renderStepInputFiles,
  onClose
}: {
  session: ChatSession
  run?: NotebookRunRecord
  disabled?: boolean
  renderStepInputFiles?: RenderStepInputFiles
  onClose: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [files, setFiles] = useState<ProjectFileItem[]>([])
  const [selected, setSelected] = useState(new Set<string>())
  const [frontierIds, setFrontierIds] = useState<Record<string, string>>({})
  const [workflows, setWorkflows] = useState<Record<string, WorkflowSelection>>({})
  const [storedBatch, setBatch] = useState<SessionReproducibilityBatch>()
  const [stepTarget, setStepTarget] = useState<StepReproductionTarget>()
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const mounted = useRef(true)
  const runtimeEpoch = useDesktopRuntimeRecoveryStore((state) => state.epoch)
  const recoveryPhase = useDesktopRuntimeRecoveryStore((state) => state.phase)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const scope = useMemo(
    () => ({ projectId: session.projectId, appSessionId: session.id }),
    [session.projectId, session.id]
  )
  const ownsBatch = !run || isStepReproductionBatch(storedBatch, scope, stepTarget)
  const batch = ownsBatch ? storedBatch : undefined
  const foreignActive =
    !ownsBatch && (storedBatch?.status === 'preparing' || storedBatch?.status === 'running')
  const polling = storedBatch?.status === 'preparing' || storedBatch?.status === 'running'
  useEffect(() => {
    let active = true
    if (run && recoveryPhase !== 'connected') return
    void Promise.allSettled([
      window.api.artifacts.sessionReproducibility?.({ ...scope, action: 'get' }),
      listAllSessionArtifacts({
        projectId: scope.projectId,
        sessionId: scope.appSessionId,
        getOverview: window.api.projectFiles.getOverview,
        readExportFiles: window.api.projectFiles.readExportFiles,
        repairIndex: window.api.projectFiles.repairIndex
      }).then(async (items) => ({
        items,
        step: run
          ? await findStepReproductionTarget({
              run,
              scope,
              files: items,
              readExecution: async (request) =>
                unwrapProvenanceRead(await window.api.artifacts.getVersionExecution(request))
            })
          : undefined
      }))
    ])
      .then(
        ([state, items]) => {
          if (!active) return
          const artifacts =
            items.status === 'fulfilled'
              ? items.value.items.filter((item) => item.source === 'artifact')
              : []
          setStepTarget(items.status === 'fulfilled' ? items.value.step : undefined)
          setBatch(state.status === 'fulfilled' ? state.value : undefined)
          setError(state.status === 'rejected' || items.status === 'rejected')
          setFiles(artifacts)
          setSelected(new Set(artifacts.slice(0, 64).map((item) => item.id)))
          const saved = state.status === 'fulfilled' ? state.value : undefined
          setFrontierIds(
            Object.fromEntries(
              artifacts.flatMap((item) => {
                const target = saved?.targets.find(
                  (row) =>
                    row.artifactId === item.sourceFileId && row.versionId === item.sourceVersionId
                )
                return target?.frontierId ? [[item.id, target.frontierId]] : []
              })
            )
          )
          setWorkflows(
            Object.fromEntries(
              artifacts.flatMap((item) => {
                const target = saved?.targets.find(
                  (row) =>
                    row.artifactId === item.sourceFileId && row.versionId === item.sourceVersionId
                )
                return target?.workflow ? [[item.id, target.workflow]] : []
              })
            )
          )
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
  }, [scope, run, runtimeEpoch, recoveryPhase])
  useEffect(() => {
    if (!polling || (run && recoveryPhase !== 'connected')) return
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
  }, [storedBatch?.batchId, polling, scope, runtimeEpoch, run, recoveryPhase])
  const command = async (request: SessionReproducibilityCommand): Promise<void> => {
    if (busy || disabled || foreignActive) return
    if (run && request.action !== 'prepare' && !ownsBatch) return
    const epoch = getDesktopRuntimeEpoch()
    setBusy(true)
    setError(false)
    try {
      if (run) assertDesktopRuntimeWrite(epoch)
      const next = await window.api.artifacts.sessionReproducibility!(request)
      if (mounted.current && (!run || epoch === getDesktopRuntimeEpoch())) setBatch(next)
    } catch {
      if (mounted.current && (!run || epoch === getDesktopRuntimeEpoch())) setError(true)
    } finally {
      if (mounted.current && (!run || epoch === getDesktopRuntimeEpoch())) setBusy(false)
    }
  }
  const active = batch && ['preparing', 'running'].includes(batch.status)
  const status = (
    value: SessionReproducibilityBatch['targets'][number]['status'],
    workflow?: WorkflowSelection
  ): string =>
    value === 'executed'
      ? t('Executed (outputs not fully verified)')
      : value === 'matched'
        ? workflow
          ? t('Compared outputs reproduced')
          : t('Result reproduced')
        : value === 'different'
          ? workflow
            ? t('Compared outputs differ')
            : t('Results differ')
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
              <Dialog.Title className={dialogTitleClassName}>
                {run ? t('Reproduce with dependencies') : t('Check session artifacts')}
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
              {run
                ? t(
                    'This check analyzes cell dependencies, restores the captured inputs and environment, and reruns the required upstream cells through this run.'
                  )
                : t(
                    'Each selected version is checked independently from its captured inputs. Closing this dialog keeps the checks running.'
                  )}
            </p>
            {run ? (
              <div className="mb-3 space-y-2 text-xs" data-testid="step-reproduction-preview">
                <p className="break-all font-medium">{run.runId}</p>
                {stepTarget ? (
                  <>
                    <p className="break-all">
                      {stepTarget.name} · {stepTarget.versionId}
                    </p>
                    <p>
                      {t('Environment')} · {stepTarget.run.environmentName ?? t('Unknown')}
                    </p>
                    {renderStepInputFiles?.(stepTarget.inputFiles)}
                  </>
                ) : loaded && !error ? (
                  <ErrorNotice
                    inline
                    description={t(
                      'No frozen capture is available for this run. Create an Artifact Version after this step to capture its evidence.'
                    )}
                  />
                ) : null}
                {foreignActive ? (
                  <ErrorNotice
                    inline
                    description={t(
                      'Another session check is active. Wait for it to finish before reproducing this run.'
                    )}
                  />
                ) : null}
                {disabled ? (
                  <ErrorNotice
                    inline
                    description={t(
                      'Reproduction is unavailable while this session is read-only, busy or recovering.'
                    )}
                  />
                ) : null}
              </div>
            ) : null}
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
                      [
                        'matched',
                        'different',
                        'executed',
                        'failed',
                        'blocked',
                        'cancelled'
                      ].includes(row.status)
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
                        <span className="shrink-0 text-xs text-text-200">
                          {status(row.status, row.workflow)}
                        </span>
                      </div>
                      {row.workflow ? (
                        <p className="mt-1 break-all text-xs text-text-300">
                          {t('Selected captured runs: {{runs}}', {
                            runs: row.workflow.targetRunIds.join(', ')
                          })}
                        </p>
                      ) : null}
                      {!run ? (
                        <StartingPoint
                          request={{
                            ...scope,
                            artifactId: row.artifactId,
                            versionId: row.versionId
                          }}
                          name={row.name}
                          frontierId={row.frontierId}
                          workflow={row.workflow}
                        />
                      ) : null}
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
                      {run && row.receiptChecksum ? (
                        <StepOutputs
                          key={row.receiptChecksum}
                          request={{
                            ...scope,
                            artifactId: row.artifactId,
                            versionId: row.versionId
                          }}
                          receiptChecksum={row.receiptChecksum}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : run ? null : (
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
                      {selected.has(file.id) ? (
                        <StartingPoint
                          key={`${file.sourceFileId}:${file.sourceVersionId}`}
                          request={{
                            ...scope,
                            artifactId: file.sourceFileId,
                            versionId: file.sourceVersionId
                          }}
                          name={file.name}
                          frontierId={frontierIds[file.id]}
                          disabled={busy}
                          workflow={workflows[file.id]}
                          onWorkflowChange={(workflow) =>
                            setWorkflows((current) => ({ ...current, [file.id]: workflow }))
                          }
                          onChange={(frontierId) =>
                            setFrontierIds((current) => ({ ...current, [file.id]: frontierId }))
                          }
                        />
                      ) : null}
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
                disabled={busy || disabled}
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
                  {run ? t('Back') : t('Change selection')}
                </Button>
                {batch.status === 'ready' ? (
                  <Button
                    size="sm"
                    disabled={
                      busy || disabled || !batch.targets.some((row) => row.status === 'queued')
                    }
                    onClick={() =>
                      void command({ ...scope, action: 'start', batchId: batch.batchId })
                    }
                  >
                    {t('Check reproducibility')}
                  </Button>
                ) : null}
              </>
            ) : run ? (
              <Button
                size="sm"
                disabled={busy || disabled || !loaded || !stepTarget || foreignActive || error}
                onClick={() => {
                  if (!stepTarget) return
                  const { artifactId, versionId, name, workflow } = stepTarget
                  void command({
                    ...scope,
                    action: 'prepare',
                    targets: [
                      { artifactId, versionId, name, frontierId: 'workflow-selection', workflow }
                    ]
                  })
                }}
              >
                {busy ? t('Preparing…') : t('Check readiness')}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={
                  busy ||
                  !loaded ||
                  !selected.size ||
                  files.some(
                    (file) =>
                      selected.has(file.id) &&
                      frontierIds[file.id] === 'workflow-selection' &&
                      !workflows[file.id]?.targetRunIds.length
                  )
                }
                onClick={() =>
                  void command({
                    ...scope,
                    action: 'prepare',
                    targets: files
                      .filter((f) => selected.has(f.id))
                      .map((f) => ({
                        artifactId: f.sourceFileId,
                        versionId: f.sourceVersionId,
                        name: f.name,
                        ...(frontierIds[f.id] ? { frontierId: frontierIds[f.id] } : {}),
                        ...(frontierIds[f.id] === 'workflow-selection'
                          ? { workflow: workflows[f.id] }
                          : {})
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
  run,
  disabled,
  renderStepInputFiles,
  onClose
}: {
  session?: ChatSession
  run?: NotebookRunRecord
  disabled?: boolean
  renderStepInputFiles?: RenderStepInputFiles
  onClose: () => void
}): React.JSX.Element | null => {
  const epoch = useDesktopRuntimeRecoveryStore((state) => state.epoch)
  const phase = useDesktopRuntimeRecoveryStore((state) => state.phase)
  // A fixed run belongs to one desktop attachment. Remount its read state on recovery so neither
  // old metadata nor an old in-flight command can unlock the reattached session's controls.
  return session ? (
    <SessionCheck
      key={`${session.projectId}:${session.id}:${run?.runId ?? ''}:${run ? `${epoch}:${phase}` : ''}`}
      session={session}
      run={run}
      disabled={disabled}
      renderStepInputFiles={renderStepInputFiles}
      onClose={onClose}
    />
  ) : null
}
