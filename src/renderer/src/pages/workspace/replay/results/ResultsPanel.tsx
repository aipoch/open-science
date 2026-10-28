import { useState } from 'react'
import { useReplayMaterialAction } from '../replay-material-action'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import type { ReplayResource } from '../../../../../../shared/replay'
import { RecordedResourcePreview } from './RecordedResourcePreview'
import { fixedReplayResource, type RecordedResourceReader } from './recorded-resource-reader'

export type ReplayResultEntry = Readonly<{
  resource: ReplayResource
  source: { kind: 'session-history' | 'run-observation' | 'project-recording'; id: string }
  /** Presentation grouping only; the resource's exact receiving Version remains authority. */
  sourceKey?: string
  sourceLabel?: string
  scope: { kind: 'step'; stepKey: string } | { kind: 'recording' }
  /** Never inferred from the filename, latest Version, terminal status, or selected step. */
  stage: 'intermediate' | 'final' | 'unspecified'
  mediaKey?: string
  /** Exact publication time from saved evidence, never the receiver import timestamp. */
  availableAt?: number
  technical?: boolean
}>
export type ResultsPanelProps = {
  entries: readonly ReplayResultEntry[]
  presentationMode?: 'default' | 'research'
  active?: boolean
  recordedAt?: number
  read: RecordedResourceReader
  onAskFile?: (entry: ReplayResultEntry) => Promise<void> | void
}
const sourceIdentity = (entry: ReplayResultEntry): string =>
  entry.sourceKey ?? JSON.stringify([entry.source.kind, entry.source.id])
const identity = (entry: ReplayResultEntry): string =>
  JSON.stringify([
    sourceIdentity(entry),
    entry.scope,
    entry.resource.projectId,
    entry.resource.sessionId,
    entry.resource.artifactId,
    entry.resource.fileId,
    entry.resource.versionId,
    entry.resource.checksum
  ])

/** Independent immutable results catalog. No Notebook, runtime service, or observation is required. */
export function ResultsPanel({
  entries,
  presentationMode = 'default',
  active = true,
  recordedAt,
  read,
  onAskFile
}: ResultsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const [scope, setScope] = useState<'current' | 'all'>('current')
  const [source, setSource] = useState('all')
  const [showTechnical, setShowTechnical] = useState(false)
  const [selectedId, setSelectedId] = useState<string>()
  const [asking, setAsking] = useState(false)
  const [askFailed, setAskFailed] = useState<string>()
  const fixed = entries.filter((entry) => fixedReplayResource(entry.resource))
  const timestamp = (entry: ReplayResultEntry): number | undefined => {
    const time = entry.availableAt ?? entry.resource.createdAt
    return time !== undefined && Number.isFinite(time) ? time : undefined
  }
  const sources = [...new Map(fixed.map((entry) => [sourceIdentity(entry), entry])).entries()]
  const selectedSource =
    source === 'all' || sources.some(([key]) => key === source) ? source : 'all'
  const fromSource = fixed.filter(
    (entry) => selectedSource === 'all' || sourceIdentity(entry) === selectedSource
  )
  const unknownTime = fromSource.some((entry) => timestamp(entry) === undefined && !entry.technical)
  const available = fromSource.filter(
    (entry) =>
      (!entry.technical || showTechnical) &&
      (scope === 'all' ||
        recordedAt === undefined ||
        (timestamp(entry) !== undefined && timestamp(entry)! <= recordedAt))
  )
  const selected = available.find((entry) => identity(entry) === selectedId)
  const ask = async (): Promise<void> => {
    if (!selected || !onAskFile || asking) return
    setAsking(true)
    setAskFailed(undefined)
    try {
      await onAskFile(selected)
    } catch {
      setAskFailed(identity(selected))
    } finally {
      setAsking(false)
    }
  }
  const sharedAction = useReplayMaterialAction(
    active && selected && onAskFile
      ? {
          label: t('Ask about this file'),
          disabled: asking,
          pending: asking,
          recordedAt: timestamp(selected),
          onAsk: () => void ask()
        }
      : undefined
  )
  const compact = presentationMode === 'research' || sharedAction
  const stageLabel = (entry: ReplayResultEntry): string =>
    entry.stage === 'final'
      ? t('Final result')
      : entry.stage === 'intermediate'
        ? t('Intermediate result')
        : t('Stage not specified')
  const publicationLabel = selected
    ? timestamp(selected) === undefined
      ? t('Publication time not recorded')
      : t('Recorded time: {{time}}', { time: new Date(timestamp(selected)!).toLocaleString() })
    : undefined
  const labelForSource = (entry: ReplayResultEntry): string =>
    entry.sourceLabel ??
    (entry.source.kind === 'session-history'
      ? t('Session history')
      : entry.source.kind === 'project-recording'
        ? t('Project recording')
        : t('Archived observation'))
  const sourceLabel = selected
    ? (selected.sourceLabel ??
      (selected.source.kind === 'session-history'
        ? t('Session history')
        : selected.source.kind === 'project-recording'
          ? t('Project recording')
          : t('Archived observation')))
    : undefined
  return (
    <section
      aria-label={t('Results')}
      // This independent catalog owns its selection and controls. Parent playback must not
      // insert inspection chrome during pointerdown and move a result before its click lands.
      data-replay-layout-control
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      {recordedAt !== undefined || sources.length > 1 ? (
        <div
          className={
            compact
              ? 'shrink-0 border-b border-border-200 px-3 py-2 text-xs'
              : 'shrink-0 border-b border-border-200 p-2 text-xs'
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            {sources.length > 1 ? (
              <select
                aria-label={t('Result source')}
                value={selectedSource}
                onChange={(event) => setSource(event.currentTarget.value)}
                className="h-7 min-w-0 max-w-full flex-1 rounded border border-border-200 bg-bg-000 px-2 text-xs"
              >
                <option value="all">{t('All research materials')}</option>
                {sources.map(([key, entry]) => (
                  <option key={key} value={key}>
                    {labelForSource(entry)}
                  </option>
                ))}
              </select>
            ) : null}
            {recordedAt !== undefined ? (
              compact ? (
                <select
                  aria-label={t('Result visibility')}
                  value={scope}
                  onChange={(event) =>
                    setScope(event.currentTarget.value === 'all' ? 'all' : 'current')
                  }
                  className="h-7 max-w-full rounded border border-border-200 bg-bg-000 px-2 text-xs"
                >
                  <option value="current">{t('Available at this moment')}</option>
                  <option value="all">{t('All saved results')}</option>
                </select>
              ) : (
                <div
                  role="group"
                  aria-label={t('Result visibility')}
                  className="flex flex-wrap gap-1"
                >
                  <Button
                    size="sm"
                    variant={scope === 'current' ? 'secondary' : 'ghost'}
                    aria-pressed={scope === 'current'}
                    onClick={() => setScope('current')}
                  >
                    {t('Available at this moment')}
                  </Button>
                  <Button
                    size="sm"
                    variant={scope === 'all' ? 'secondary' : 'ghost'}
                    aria-pressed={scope === 'all'}
                    onClick={() => setScope('all')}
                  >
                    {t('All saved results')}
                  </Button>
                </div>
              )
            ) : null}
          </div>
          {recordedAt !== undefined && (!compact || scope === 'all') ? (
            <p className="mt-1 text-muted-foreground">
              {scope === 'all'
                ? selectedSource === 'all'
                  ? t('Showing results from the entire research, including later records.')
                  : t('Showing all saved results from this source, including later records.')
                : t(
                    'Only results with a known publication time at or before this moment are shown.'
                  )}
            </p>
          ) : null}
          {recordedAt !== undefined && scope === 'current' && unknownTime ? (
            <p className="mt-1 text-muted-foreground">
              {t(
                'Some results have no saved publication time. Use All saved results to inspect them.'
              )}
            </p>
          ) : null}
        </div>
      ) : null}
      {fixed.some((entry) => entry.technical) ? (
        <label className="flex shrink-0 items-center gap-2 p-2 text-xs">
          <input
            type="checkbox"
            checked={showTechnical}
            onChange={(event) => setShowTechnical(event.currentTarget.checked)}
          />
          {t('Show technical attachments')}
        </label>
      ) : null}
      <div
        className={
          compact
            ? 'max-h-36 shrink-0 overflow-auto border-b border-border-200 p-1.5'
            : 'max-h-48 shrink-0 overflow-auto border-b border-border-200 p-2'
        }
      >
        {available.length ? (
          available.map((entry) => (
            <Button
              key={identity(entry)}
              variant="ghost"
              className="h-auto w-full justify-start whitespace-normal text-left"
              aria-pressed={identity(entry) === selectedId}
              onClick={() => setSelectedId(identity(entry))}
            >
              <span className="min-w-0">
                <span className="block truncate">{entry.resource.name}</span>
                {!compact ? (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {entry.scope.kind === 'step' ? t('Step result') : t('Recording attachment')}
                    {' · '}
                    {stageLabel(entry)}
                  </span>
                ) : entry.stage !== 'unspecified' ? (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {stageLabel(entry)}
                  </span>
                ) : null}
              </span>
            </Button>
          ))
        ) : (
          <div className="space-y-2 p-2 text-sm text-muted-foreground">
            <p>
              {fromSource.some((entry) => !entry.technical || showTechnical) &&
              recordedAt !== undefined &&
              scope === 'current'
                ? t('No results have a known publication time before this moment.')
                : t('No recorded results are available.')}
            </p>
            {scope === 'current' &&
            recordedAt !== undefined &&
            fromSource.some((entry) => !entry.technical || showTechnical) ? (
              <Button size="sm" variant="outline" onClick={() => setScope('all')}>
                {t('View all results')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {selected ? (
        <>
          {compact ? (
            <div className="shrink-0 border-b border-border-200 px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-medium" title={selected.resource.name}>
                  {selected.resource.name}
                </span>
                {onAskFile && !sharedAction ? (
                  <Button size="sm" variant="outline" disabled={asking} onClick={() => void ask()}>
                    {t('Ask about this file')}
                  </Button>
                ) : null}
              </div>
              <details className="mt-1 text-muted-foreground">
                <summary className="w-fit cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {t('Result details')}
                </summary>
                <div className="mt-2 space-y-1 break-words">
                  <p>{sourceLabel}</p>
                  <p>
                    {selected.scope.kind === 'step' ? t('Step result') : t('Recording attachment')}
                    {' · '}
                    {stageLabel(selected)}
                  </p>
                  <p>{publicationLabel}</p>
                  <p>
                    <span>{t('Version')}</span>
                    {': '}
                    <code className="break-all">{selected.resource.versionId}</code>
                  </p>
                </div>
              </details>
            </div>
          ) : (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-200 p-2 text-xs">
              <span>{sourceLabel}</span>
              <span>{publicationLabel}</span>
              <code className="break-all">{selected.resource.versionId}</code>
              {onAskFile && !sharedAction ? (
                <Button size="sm" variant="outline" disabled={asking} onClick={() => void ask()}>
                  {t('Ask about this file')}
                </Button>
              ) : null}
            </div>
          )}
          {askFailed === selectedId ? (
            <ErrorNotice inline title={t('Could not reference this recorded file.')} />
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto">
            <RecordedResourcePreview key={selectedId} resource={selected.resource} read={read} />
          </div>
        </>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          {t('Select a recorded file to preview.')}
        </p>
      )}
    </section>
  )
}
