import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ChevronRight, LoaderCircle } from 'lucide-react'
import { Tabs } from 'radix-ui'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import type { LiteratureRelatedRecord } from '@aipoch/literature-discovery/contracts'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import {
  citationGraphRecordsMatch,
  normalizeCitationPaperId,
  type CitationMetadata,
  type CitationGraphFilter
} from './citation-graph'
import {
  useCitationSource,
  type CitationProviderChoice,
  type CitationSourceState
} from './useCitationSource'
import {
  useCitationGraphController,
  type CitationGraphControllerProps,
  type ScheduleRequest
} from './useCitationGraphController'
import { LiteratureCitationCanvas } from './LiteratureCitationCanvas'
import {
  LiteratureCitationInspector,
  type CitationInspectorHandle
} from './LiteratureCitationInspector'

export type GraphProps = {
  paperMetadata?: CitationMetadata
  item: LiteratureItemView
  onSaved(): void
  onSavingChange?(saving: boolean): void
  onReferenceChanged?(): void
  referenceInvalidated?: boolean
  isReferenceInvalidated?: () => boolean
  disabled?: boolean
  visible?: boolean
  provider?: CitationProviderChoice
  source?: CitationSourceState
  requestRelated?: ScheduleRequest
  directionMode?: 'single' | 'both'
}
type GraphFrame = { key: string; center?: LiteratureRelatedRecord; parentToken?: string }
const GRAPH_HISTORY_LIMIT = 8
const citationFilters = ['all', 'references', 'citations'] as const

export function LiteratureCitationGraph(props: GraphProps): React.JSX.Element {
  const [restart, setRestart] = useState(0)
  const restartSession = useCallback(() => setRestart((value) => value + 1), [])
  return (
    <CitationGraphSession
      key={`${props.item.id}:${props.item.metadataRevision}:${props.provider ?? 'europe-pmc'}:${restart}`}
      {...props}
      onRestart={restartSession}
    />
  )
}

function CitationGraphSession({
  onRestart,
  ...props
}: GraphProps & { onRestart(): void }): React.JSX.Element {
  const { t } = useTranslation()
  const localSource = useCitationSource(props.provider ?? 'europe-pmc')
  const source = props.source ?? localSource.source
  const requestRelated = props.requestRelated ?? localSource.requestRelated
  const { onSavingChange, onReferenceChanged, isReferenceInvalidated } = props
  const [paperMetadata] = useState<CitationMetadata>(() => props.paperMetadata ?? new Map())
  const [frames, setFrames] = useState<GraphFrame[]>([{ key: 'root' }])
  const [current, setCurrent] = useState('root')
  const [history, setHistory] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [referenceChanged, setReferenceChanged] = useState(false)
  const invalidatedSession = useRef(false)
  useEffect(() => {
    if (props.referenceInvalidated) invalidatedSession.current = true
  }, [props.referenceInvalidated])
  const rootRecord = useRef<LiteratureRelatedRecord | undefined>(undefined)
  const sessionElement = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() =>
      sessionElement.current
        ?.querySelector<HTMLElement>('[data-citation-center-title]')
        ?.focus({ preventScroll: true })
    )
    return () => cancelAnimationFrame(frame)
  }, [current])
  const schedule = useCallback<ScheduleRequest>(
    async (request, shouldRun) => {
      if (invalidatedSession.current || isReferenceInvalidated?.() || !shouldRun())
        throw new Error('Inactive graph request.')
      return requestRelated(
        request,
        () => !invalidatedSession.current && !isReferenceInvalidated?.() && shouldRun()
      )
    },
    [requestRelated, isReferenceInvalidated]
  )
  const handleSavingChange = useCallback(
    (value: boolean) => {
      setSaving(value)
      onSavingChange?.(value)
    },
    [onSavingChange]
  )
  const markChanged = useCallback(() => {
    invalidatedSession.current = true
    setReferenceChanged(true)
    onReferenceChanged?.()
  }, [onReferenceChanged])
  const rootResolved = useCallback((record: LiteratureRelatedRecord) => {
    rootRecord.current = record
  }, [])
  const explore = (record: LiteratureRelatedRecord, parentToken: string): void => {
    if (saving || invalidatedSession.current) return
    const paperId = normalizeCitationPaperId(record.paperId)
    const existing = frames.find(
      (frame) => frame.center && citationGraphRecordsMatch(frame.center, record)
    )
    const key =
      rootRecord.current && citationGraphRecordsMatch(rootRecord.current, record)
        ? 'root'
        : (existing?.key ?? paperId)
    if (key === current) return
    let nextFrames = frames
    if (!frames.some((frame) => frame.key === key)) {
      if (frames.length >= GRAPH_HISTORY_LIMIT) {
        const evicted = frames.find((frame) => frame.key !== 'root' && frame.key !== current)!
        nextFrames = frames.filter((frame) => frame.key !== evicted.key)
      }
      nextFrames = [...nextFrames, { key, center: record, parentToken }]
      setFrames(nextFrames)
    }
    const retained = new Set(nextFrames.map((frame) => frame.key))
    setHistory((previous) =>
      [...previous.filter((key) => retained.has(key)), current].slice(-(GRAPH_HISTORY_LIMIT - 1))
    )
    setCurrent(key)
  }
  return (
    <div ref={sessionElement} className="flex min-h-0 flex-1 flex-col">
      <div
        data-citation-context-header
        role="region"
        aria-label={t('Current center')}
        className="flex h-9 shrink-0 items-center gap-1 border-b border-border-300 bg-muted/25 px-2 sm:px-3"
      >
        {history.length ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            aria-label={t('Back')}
            onClick={() => {
              setCurrent(history[history.length - 1])
              setHistory((previous) => previous.slice(0, -1))
            }}
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">{t('Back')}</span>
          </Button>
        ) : null}
        {current !== 'root' ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setCurrent('root')
              setHistory([])
            }}
          >
            {t('Original paper')}
          </Button>
        ) : null}
        <nav aria-label={t('Exploration path')} className="min-w-0 flex-1 overflow-x-auto">
          <ol className="flex items-center gap-1 [&>li:last-child]:min-w-0 [&>li:last-child]:flex-1">
            {(history[0] === 'root' || (!history.length && current === 'root')
              ? [...history, current]
              : ['root', ...history, current]
            ).map((key, index, path) => {
              const isCurrent = index === path.length - 1
              const title =
                frames.find((frame) => frame.key === key)?.center?.item.title ??
                props.item.item.title
              const prefixedRoot =
                path[0] === 'root' &&
                history[0] !== 'root' &&
                (history.length > 0 || current !== 'root')
              return (
                <li key={`${key}:${index}`} title={title} className="flex items-center gap-1">
                  {index ? (
                    <ChevronRight
                      className="size-3 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    title={title}
                    aria-current={isCurrent ? 'page' : undefined}
                    disabled={saving}
                    className={`min-w-0 justify-start ${isCurrent ? 'w-full shrink font-medium' : 'max-w-16 sm:max-w-40'}`}
                    onClick={() => {
                      if (isCurrent) return
                      setCurrent(key)
                      setHistory((previous) =>
                        index === 0 && prefixedRoot
                          ? []
                          : previous.slice(0, index - (prefixedRoot ? 1 : 0))
                      )
                    }}
                  >
                    <span
                      data-citation-center-title={isCurrent ? '' : undefined}
                      data-citation-current-center={isCurrent ? '' : undefined}
                      tabIndex={isCurrent ? -1 : undefined}
                      className="min-w-0 truncate outline-none"
                    >
                      {title}
                    </span>
                  </Button>
                </li>
              )
            })}
          </ol>
        </nav>
        {current !== 'root' ? (
          <span className="sr-only text-[10px] text-muted-foreground sm:not-sr-only sm:shrink-0">
            {t('Temporary center')}
          </span>
        ) : null}
      </div>
      {referenceChanged && !onReferenceChanged ? (
        <ErrorNotice
          className="mx-5 mt-3"
          inline
          role="alert"
          description={t('This reference changed. Reopen its details and try again.')}
        />
      ) : null}
      {frames.map((frame) => (
        <div
          key={frame.key}
          hidden={frame.key !== current}
          data-current-frame={frame.key === current}
          style={{ display: frame.key === current ? undefined : 'none' }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <CitationGraphCenter
            {...props}
            source={source}
            paperMetadata={paperMetadata}
            center={frame.center}
            parentToken={frame.parentToken}
            visible={props.visible !== false && frame.key === current}
            disabled={props.disabled || referenceChanged}
            schedule={schedule}
            invalidatedSession={invalidatedSession}
            onReferenceChanged={markChanged}
            onRootResolved={rootResolved}
            onRestart={onRestart}
            onExplore={explore}
            onSavingChange={handleSavingChange}
          />
        </div>
      ))}
    </div>
  )
}

type CitationGraphFrameProps = CitationGraphControllerProps &
  Pick<GraphProps, 'visible' | 'source'> & { paperMetadata: CitationMetadata; onRestart(): void }

function CitationGraphCenter(props: CitationGraphFrameProps): React.JSX.Element {
  const controller = useCitationGraphController({
    ...props,
    opencitationsMode: props.source?.opencitationsMode
  })
  const marker = useId().replace(/:/g, '')
  const inspector = useRef<CitationInspectorHandle>(null)
  const sidebarToggle = useRef<HTMLButtonElement>(null)
  const [detailsOpen, setDetailsOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 1024
  )
  useEffect(() => {
    const media = window.matchMedia?.('(min-width: 1024px)')
    if (!media) return
    const resized = (): void => setDetailsOpen(media.matches)
    media.addEventListener('change', resized)
    return () => media.removeEventListener('change', resized)
  }, [])
  const selectPaper = (id: string): void => {
    controller.setSelected(id)
    setDetailsOpen(true)
    inspector.current?.showDetails()
  }
  const visible = props.visible !== false
  const title = props.center?.item.title ?? props.item.item.title
  const { t } = useTranslation()
  const sourceName =
    props.source?.provider === 'europe-pmc'
      ? t('Europe PMC')
      : props.source?.provider === 'opencitations'
        ? props.source.opencitationsMode === 'index'
          ? t('OpenCitations · Index v2')
          : t('OpenCitations · SKG-IF')
        : t('Europe PMC')
  const directionLabel = (filter: CitationGraphFilter): string =>
    filter === 'all' ? t('All') : filter === 'references' ? t('References') : t('Cited by')
  return (
    <Tabs.Root
      data-citation-workspace
      value={controller.filter}
      onValueChange={(value) => controller.setDirection(value as CitationGraphFilter)}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <span id={`${marker}-center-title`} className="sr-only">
        {title}
      </span>
      <Tabs.List
        aria-label={t('Relationship regions')}
        data-citation-direction-tabs
        className="absolute top-2 left-2 z-20 max-w-[calc(100%-1rem)] sm:top-3 sm:left-3"
      >
        <div className="inline-flex max-w-full items-center gap-0.5 rounded-lg border border-border-300 bg-card p-0.5 shadow-sm">
          {citationFilters.map((direction) => {
            const active = controller.filter === direction
            return (
              <Tabs.Trigger
                key={direction}
                value={direction}
                disabled={controller.interactionBusy || controller.invalidated}
                asChild
              >
                <Button
                  data-citation-direction-tab={direction}
                  size="sm"
                  variant="ghost"
                  disabled={controller.interactionBusy || controller.invalidated}
                  className={`h-7 min-w-11 rounded px-2.5 text-xs font-medium ${active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => controller.setDirection(direction)}
                >
                  {directionLabel(direction)}
                  {!detailsOpen && controller.busy === direction && (
                    <LoaderCircle
                      aria-label={t('Loading…')}
                      role="img"
                      className="size-3.5 motion-safe:animate-spin"
                    />
                  )}
                </Button>
              </Tabs.Trigger>
            )
          })}
        </div>
      </Tabs.List>
      <Tabs.Content
        value={controller.filter}
        forceMount
        className={`grid min-h-0 flex-1 overflow-hidden sm:grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_auto] lg:grid-rows-[minmax(0,1fr)] ${detailsOpen ? 'grid-rows-[minmax(0,3fr)_minmax(0,2fr)]' : 'grid-rows-[minmax(0,1fr)_auto]'}`}
      >
        <LiteratureCitationCanvas
          model={{
            graph: controller.graph,
            unfilteredGraph: controller.unfilteredGraph,
            filter: controller.filter,
            selectedNode: controller.selectedNode,
            setSelected: selectPaper,
            busy: controller.busy,
            additionalPages:
              Math.max(0, controller.states.references.pages - 1) +
              Math.max(0, controller.states.citations.pages - 1),
            initialSearchSettled:
              Boolean(controller.states.references.result) &&
              (Boolean(controller.states.citations.result) ||
                ['expired', 'reference-changed'].includes(
                  controller.states.references.result?.issue ?? ''
                )),
            centerTitle: title,
            sourceName
          }}
          marker={marker}
          visible={visible}
          sidebarExpanded={detailsOpen}
          sidebarToggle={sidebarToggle}
          onToggleSidebar={() => setDetailsOpen((value) => !value)}
          onViewSelected={() => {
            setDetailsOpen(true)
            inspector.current?.focus()
          }}
        />
        <LiteratureCitationInspector
          paperMetadata={props.paperMetadata}
          ref={inspector}
          toggle={sidebarToggle}
          expanded={detailsOpen}
          onExpandedChange={setDetailsOpen}
          model={{
            filter: controller.filter,
            setDirection: controller.setDirection,
            selected: controller.selected,
            selectedNode: controller.selectedNode,
            graph: controller.graph,
            blocked: controller.blocked,
            saving: controller.saving,
            save: controller.save,
            setSelected: controller.setSelected,
            exploreSelected: controller.exploreSelected,
            receiptFor: controller.receiptFor,
            receipt: controller.selectedReceipt,
            temporaryCenter: Boolean(props.center),
            canExplore: Boolean(controller.resolutionToken)
          }}
          statusModel={controller}
          sourceName={sourceName}
          onRestart={props.onRestart}
          marker={marker}
          visible={visible}
        />
      </Tabs.Content>
    </Tabs.Root>
  )
}
