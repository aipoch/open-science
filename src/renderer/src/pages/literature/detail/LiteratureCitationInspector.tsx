import { CitationAbstract } from './LiteratureDetailText'
import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Inbox, FileText } from 'lucide-react'
import { Tabs } from 'radix-ui'
import { Button } from '@/components/ui/button'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { fullCreatorLabel, getExternalLiteratureUrl } from '../literature-item-display'
import { LiteratureCitationStatus, type CitationStatusModel } from './LiteratureCitationStatus'
import type { CitationGraphNode, CitationGraphRelation } from './citation-graph'
import type { CitationGraphController } from './useCitationGraphController'

export type CitationInspectorModel = Pick<
  CitationGraphController,
  | 'selected'
  | 'selectedNode'
  | 'graph'
  | 'blocked'
  | 'saving'
  | 'save'
  | 'exploreSelected'
  | 'filter'
  | 'setDirection'
> & {
  setSelected(id: string): void
  receipt: CitationGraphController['receipts'][string] | undefined
  temporaryCenter: boolean
  canExplore: boolean
}

export type CitationInspectorHandle = { focus(): void; showDetails(): void }

export function LiteratureCitationInspector({
  model,
  statusModel,
  sourceName,
  onRestart,
  marker,
  visible,
  expanded,
  onExpandedChange,
  toggle,
  onOpenInbox,
  ref
}: {
  model: CitationInspectorModel
  statusModel: CitationStatusModel
  sourceName: string
  onRestart(): void
  marker: string
  visible: boolean
  expanded: boolean
  onExpandedChange(expanded: boolean): void
  toggle: React.RefObject<HTMLButtonElement | null>
  onOpenInbox?(): void
  ref: React.Ref<CitationInspectorHandle>
}): React.JSX.Element {
  const { t } = useTranslation()
  const {
    selected,
    selectedNode,
    graph,
    receipt,
    temporaryCenter,
    blocked,
    canExplore,
    saving,
    save,
    setSelected,
    exploreSelected
  } = model
  const [listOpen, setListOpen] = useState(true)
  const [listDirection, setListDirection] = useState<'references' | 'citations'>('references')
  const direction = model.filter === 'all' ? listDirection : model.filter
  const listScroll = useRef({ references: 0, citations: 0 })
  const pane = useRef<HTMLElement>(null)
  const outer = useRef<HTMLDivElement>(null)
  const inspectorTitle = useRef<HTMLHeadingElement>(null)
  const scroll = useRef(0)
  const pendingFocus = useRef(false)
  const resetScroll = useCallback(() => {
    if (pane.current) pane.current.scrollTop = 0
    if (outer.current) outer.current.scrollTop = 0
    scroll.current = 0
  }, [])
  useLayoutEffect(() => {
    if (!expanded && pane.current?.contains(document.activeElement)) {
      toggle.current?.focus({ preventScroll: true })
    }
    if (!expanded) resetScroll()
    if (expanded && pendingFocus.current) {
      pendingFocus.current = false
      inspectorTitle.current?.focus({ preventScroll: true })
    }
  }, [expanded, resetScroll, toggle])
  useLayoutEffect(() => {
    if (visible && graph && outer.current) outer.current.scrollTop = scroll.current
  }, [visible, graph])
  // Keep the raw selection identity: merging aliases must not reset this paper's scroll.
  useLayoutEffect(() => {
    resetScroll()
  }, [selected, resetScroll])
  useImperativeHandle(
    ref,
    () => ({
      showDetails() {
        if (listOpen) listScroll.current[direction] = outer.current?.scrollTop ?? 0
        setListOpen(false)
        resetScroll()
      },
      focus() {
        if (listOpen) listScroll.current[direction] = outer.current?.scrollTop ?? 0
        setListOpen(false)
        pendingFocus.current = !expanded
        resetScroll()
        inspectorTitle.current?.focus({ preventScroll: true })
      }
    }),
    [expanded, resetScroll, listOpen, direction]
  )
  useLayoutEffect(() => {
    if (outer.current) outer.current.scrollTop = listOpen ? listScroll.current[direction] : 0
  }, [listOpen, direction, expanded])
  const relationLabel = (relation: CitationGraphRelation): string =>
    relation === 'references'
      ? t('References')
      : relation === 'citations'
        ? t('Papers citing this paper')
        : relation === 'both'
          ? t('Both directions')
          : t('Current center')
  const paperRow = (node: CitationGraphNode): React.JSX.Element => (
    <li key={node.id}>
      <button
        type="button"
        data-citation-paper-id={node.id}
        aria-pressed={selectedNode?.id === node.id}
        className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted aria-pressed:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => {
          listScroll.current[direction] = outer.current?.scrollTop ?? 0
          setSelected(node.id)
          setListOpen(false)
          resetScroll()
          inspectorTitle.current?.focus({ preventScroll: true })
        }}
      >
        <span
          aria-hidden="true"
          className={`mt-1.5 size-2 shrink-0 rounded-full ${node.relation === 'references' ? 'bg-chart-1' : node.relation === 'citations' ? 'bg-chart-3' : node.relation === 'both' ? 'bg-chart-1 ring-2 ring-chart-3' : 'bg-primary'}`}
        />
        <span className="min-w-0 space-y-1">
          <span className="block line-clamp-3 text-sm leading-snug">{node.record.item.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {[fullCreatorLabel(node.record.item), node.record.item.issuedYear]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {node.center ? (
            <span className="block text-xs text-muted-foreground">{t('Current center')}</span>
          ) : null}
        </span>
      </button>
    </li>
  )
  const collapse = (): void => {
    resetScroll()
    if (pane.current?.contains(document.activeElement))
      toggle.current?.focus({ preventScroll: true })
    onExpandedChange(false)
  }
  return (
    <section
      ref={pane}
      data-citation-inspector-pane
      aria-label={t('Selected paper')}
      aria-describedby={selectedNode?.center ? `${marker}-center-title` : undefined}
      data-expanded={expanded}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !expanded) return
        // Leave modal dismissal to a subsequent Escape after closing this local disclosure.
        event.preventDefault()
        event.stopPropagation()
        if (listOpen) {
          setListOpen(false)
          resetScroll()
          pane.current
            ?.querySelector<HTMLButtonElement>('[data-citation-paper-list-toggle]')
            ?.focus()
        } else collapse()
      }}
      className={
        expanded
          ? 'flex min-h-0 flex-col overflow-x-hidden overflow-y-auto overscroll-contain border-t border-border-300 bg-background sm:max-h-[42vh] lg:max-h-none lg:w-80 lg:border-t-0 lg:border-l'
          : 'hidden'
      }
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border-300 px-2">
        {listOpen ? (
          <h3 className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{t('Paper list')}</h3>
        ) : null}
        {expanded && graph ? (
          <Button
            size={listOpen ? 'icon-sm' : 'sm'}
            className={listOpen ? undefined : 'mr-auto min-w-0'}
            variant={listOpen ? 'secondary' : 'ghost'}
            data-citation-paper-list-toggle
            aria-label={listOpen ? t('Selected paper') : t('Back to list')}
            title={listOpen ? t('Selected paper') : t('Back to list')}
            aria-expanded={listOpen}
            aria-controls={`${marker}-paper-list`}
            onClick={() => {
              if (listOpen) listScroll.current[direction] = outer.current?.scrollTop ?? 0
              setListOpen((value) => !value)
            }}
          >
            {listOpen ? (
              <FileText className="size-4" aria-hidden="true" />
            ) : (
              <>
                <ArrowLeft className="size-4" aria-hidden="true" />
                <span className="truncate">{t('Back to list')}</span>
              </>
            )}
          </Button>
        ) : null}
        {expanded && onOpenInbox ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('Open Inbox')}
            title={t('Open Inbox')}
            disabled={saving}
            onClick={onOpenInbox}
          >
            <Inbox className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <Tabs.Root
        value={direction}
        onValueChange={(value) => {
          const next = value as typeof direction
          listScroll.current[direction] = outer.current?.scrollTop ?? 0
          setListDirection(next)
          if (model.filter !== 'all') model.setDirection(next)
        }}
        id={`${marker}-inspector-content`}
        hidden={!expanded}
        className={expanded ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
      >
        {listOpen ? (
          <Tabs.List
            aria-label={t('Paper list')}
            className="flex shrink-0 border-b border-border-300 px-3"
          >
            {(['references', 'citations'] as const).map((value) => {
              const loaded =
                statusModel.unfilteredGraph?.nodes.filter(
                  (node) => !node.center && (node.relation === value || node.relation === 'both')
                ).length ?? 0
              return (
                <Tabs.Trigger
                  key={value}
                  value={value}
                  disabled={
                    model.filter !== 'all' &&
                    (statusModel.interactionBusy || statusModel.invalidated)
                  }
                  className="flex min-w-0 flex-1 items-center justify-center gap-2 border-b-2 border-transparent px-2 py-3 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50 data-[state=active]:border-primary data-[state=active]:text-primary"
                >
                  {value === 'references' ? t('References') : t('Cited by')}
                  {statusModel.states[value].pages > 0 ? (
                    <span
                      className="tabular-nums"
                      title={t('Loaded: {{loaded}}', { loaded })}
                      aria-label={t('Loaded: {{loaded}}', { loaded })}
                    >
                      {loaded}
                    </span>
                  ) : null}
                </Tabs.Trigger>
              )
            })}
          </Tabs.List>
        ) : null}
        <Tabs.Content
          forceMount
          value={direction}
          ref={outer}
          data-citation-inspector
          data-citation-graph-scroll
          onScroll={(event) => {
            if (visible && expanded) {
              scroll.current = event.currentTarget.scrollTop
              if (listOpen) listScroll.current[direction] = event.currentTarget.scrollTop
            }
          }}
          className="min-h-24 flex-1 overflow-y-auto overscroll-auto px-3 py-3 sm:px-4"
        >
          <h3
            ref={inspectorTitle}
            tabIndex={-1}
            data-citation-inspector-title
            className={
              listOpen
                ? 'sr-only'
                : 'mb-4 break-words text-base font-semibold leading-snug outline-none'
            }
          >
            {selectedNode?.record.item.title ?? t('Selected paper')}
          </h3>
          {selectedNode && !listOpen ? (
            <div className="space-y-4">
              <div className="flex flex-col items-start gap-2">
                <div className="flex min-w-0 flex-col items-start gap-1 text-xs leading-relaxed">
                  {fullCreatorLabel(selectedNode.record.item) ? (
                    <span
                      title={fullCreatorLabel(selectedNode.record.item)}
                      className="line-clamp-2 min-w-0 break-words"
                    >
                      {fullCreatorLabel(selectedNode.record.item)}
                    </span>
                  ) : null}
                  <span className="text-muted-foreground">
                    {selectedNode.record.item.issuedYear?.toString() ?? t('No year')}
                  </span>
                </div>
                <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className={`size-2 rounded-full ${selectedNode.relation === 'references' ? 'bg-chart-1' : selectedNode.relation === 'citations' ? 'bg-chart-3' : selectedNode.relation === 'center' ? 'bg-muted-foreground' : 'bg-chart-1 ring-2 ring-chart-3'}`}
                  />
                  {relationLabel(selectedNode.relation)}
                </p>
              </div>
              <div className="flex flex-col items-start gap-2">
                {selectedNode.record.item.containerTitle ? (
                  <p className="text-xs text-muted-foreground">
                    {selectedNode.record.item.containerTitle}
                  </p>
                ) : null}
                {getExternalLiteratureUrl(selectedNode.record.item.url) ? (
                  <ExternalTextLink
                    href={selectedNode.record.item.url}
                    className="text-xs text-muted-foreground"
                  >
                    {t('Open in {{source}}', {
                      source: selectedNode.record.paperId.startsWith('europe-pmc:')
                        ? t('Europe PMC')
                        : 'OpenCitations'
                    })}
                  </ExternalTextLink>
                ) : null}
              </div>
              <CitationAbstract
                text={selectedNode.record.item.abstract}
                className="border-t border-border-300 pt-3 [&>summary]:font-medium"
              />
            </div>
          ) : !selectedNode && !listOpen ? (
            <p className="text-sm text-muted-foreground">
              {t('Select a paper to view its details.')}
            </p>
          ) : null}
          {listOpen && visible ? (
            <section id={`${marker}-paper-list`} aria-label={t('Paper list')}>
              <LiteratureCitationStatus
                model={statusModel}
                direction={direction}
                sourceName={sourceName}
                onRestart={onRestart}
                renderRecords={(direction) => (
                  <ol className="space-y-1">
                    {graph?.nodes
                      .filter(
                        (node) =>
                          !node.center && (node.relation === direction || node.relation === 'both')
                      )
                      .map(paperRow)}
                  </ol>
                )}
              />
            </section>
          ) : null}
        </Tabs.Content>
        {selectedNode && (!selectedNode.center || temporaryCenter || receipt) ? (
          <div
            data-citation-inspector-actions
            className="shrink-0 space-y-2 border-t border-border-300 bg-card px-3 py-2 sm:px-4"
          >
            <div
              data-citation-inspector-primary-actions
              className="flex flex-wrap items-center gap-2"
            >
              {!selectedNode.center ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked || !canExplore}
                  onClick={() => {
                    exploreSelected()
                  }}
                >
                  {t('Set as center')}
                </Button>
              ) : null}
              {!selectedNode.center || temporaryCenter ? (
                <>
                  <Button
                    size="sm"
                    disabled={blocked || (receipt !== undefined && receipt !== 'failed')}
                    onClick={() => void save()}
                  >
                    {saving ? t('Saving…') : t('Add to Inbox')}
                  </Button>
                </>
              ) : null}
            </div>
            {receipt ? (
              <p role="status" className="text-xs">
                {receipt === 'failed'
                  ? t('Could not add this reference. Try again.')
                  : receipt.kind === 'item' || receipt.state === 'accepted'
                    ? t('Already in Library')
                    : receipt.state === 'dismissed'
                      ? t('Previously dismissed; review it in Inbox.')
                      : t('In Inbox')}
              </p>
            ) : null}
          </div>
        ) : null}
      </Tabs.Root>
    </section>
  )
}
