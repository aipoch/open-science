import { CitationPaperDetails } from './CitationPaperDetails'
import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RotateCw,
  ListChecks,
  ArrowLeft,
  ChevronRight,
  Inbox,
  FileText,
  LoaderCircle,
  Crosshair,
  Check
} from 'lucide-react'
import { Tabs } from 'radix-ui'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { creatorLabel } from '../literature-item-display'
import { LiteratureCitationStatus, type CitationStatusModel } from './LiteratureCitationStatus'
import type { CitationGraphNode, CitationMetadata } from './citation-graph'
import type { CitationGraphController } from './useCitationGraphController'

export type CitationInspectorModel = Pick<
  CitationGraphController,
  | 'selected'
  | 'selectedNode'
  | 'receiptFor'
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

function PaperAction({
  label,
  hint = label,
  disabled,
  onClick,
  children
}: {
  label: string
  hint?: string
  disabled: boolean
  onClick(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-disabled={disabled || undefined}
          className="hover:bg-primary/15 hover:text-primary focus-visible:bg-primary/15 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onClick={() => {
            if (!disabled) onClick()
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

export function LiteratureCitationInspector({
  model,
  paperMetadata,
  statusModel,
  sourceName,
  onRestart,
  marker,
  visible,
  expanded,
  onExpandedChange,
  toggle,
  ref
}: {
  model: CitationInspectorModel
  paperMetadata: CitationMetadata
  statusModel: CitationStatusModel
  sourceName: string
  onRestart(): void
  marker: string
  visible: boolean
  expanded: boolean
  onExpandedChange(expanded: boolean): void
  toggle: React.RefObject<HTMLButtonElement | null>
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
  const [checked, setChecked] = useState<Set<string>>()
  const selecting = checked !== undefined
  const checkedNodes = checked
    ? (statusModel.unfilteredGraph?.nodes.filter(
        (node) => !node.center && !node.conflicting && node.paperIds.some((id) => checked.has(id))
      ) ?? [])
    : []
  const selectedPapers = checkedNodes.filter((node) => {
    const receipt = model.receiptFor(node)
    return !receipt || receipt === 'failed'
  })
  const failedCount = selectedPapers.filter((node) => model.receiptFor(node) === 'failed').length
  const retrySelection = failedCount > 0 && failedCount === selectedPapers.length
  const [listOpen, setListOpen] = useState(true)
  const [listDirection, setListDirection] = useState<'references' | 'citations'>('references')
  const direction = model.filter === 'all' ? listDirection : model.filter
  const listScroll = useRef({ references: 0, citations: 0 })
  const pane = useRef<HTMLElement>(null)
  const outer = useRef<HTMLDivElement>(null)
  const inspectorTitle = useRef<HTMLHeadingElement>(null)
  const scroll = useRef(0)
  const pendingFocus = useRef(false)
  const returnToRow = useRef(false)
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
    if (!listOpen) resetScroll()
  }, [selected, listOpen, resetScroll])
  const showDetails = useCallback(() => {
    if (selecting) return
    if (listOpen) listScroll.current[direction] = outer.current?.scrollTop ?? 0
    setListOpen(false)
    resetScroll()
  }, [direction, listOpen, resetScroll, selecting])
  const focusDetails = useCallback(() => {
    showDetails()
    pendingFocus.current = !expanded
    inspectorTitle.current?.focus({ preventScroll: true })
  }, [expanded, showDetails])
  useImperativeHandle(ref, () => ({ showDetails, focus: focusDetails }), [
    showDetails,
    focusDetails
  ])
  useLayoutEffect(() => {
    scroll.current = listOpen ? listScroll.current[direction] : 0
    if (outer.current) outer.current.scrollTop = scroll.current
    if (listOpen && returnToRow.current) {
      returnToRow.current = false
      outer.current
        ?.querySelector<HTMLButtonElement>('[data-citation-paper-id][aria-pressed="true"]')
        ?.focus({ preventScroll: true })
    }
  }, [listOpen, direction, expanded])
  const receiptLabel = (receipt: CitationInspectorModel['receipt']): string | undefined =>
    !receipt
      ? undefined
      : receipt === 'failed'
        ? t('Could not add this reference. Try again.')
        : receipt.kind === 'item' || receipt.state === 'accepted'
          ? t('Already in Library')
          : receipt.state === 'dismissed'
            ? t('Previously dismissed; review it in Inbox.')
            : t('In Inbox')
  const receiptText = receiptLabel(receipt)
  const saveDisabled =
    blocked || selectedNode?.conflicting === true || (receipt !== undefined && receipt !== 'failed')
  const centerDisabled = blocked || selectedNode?.conflicting === true || !canExplore
  const saveLabel = saving ? t('Saving…') : t('Add to Inbox')
  const SaveIcon = saving ? LoaderCircle : Inbox
  const saveIcon = (
    <SaveIcon aria-hidden="true" className={saving ? 'motion-safe:animate-spin' : undefined} />
  )
  const paperRow = (node: CitationGraphNode): React.JSX.Element => {
    const Row = selecting ? 'label' : 'button'
    const rowReceipt = selecting ? model.receiptFor(node) : undefined
    const alreadySaved = Boolean(rowReceipt && rowReceipt !== 'failed')
    const included =
      !node.conflicting && !alreadySaved && node.paperIds.some((id) => checked?.has(id))
    const highlighted = selecting ? included : selectedNode?.id === node.id
    return (
      <li key={node.id} className={highlighted ? 'rounded-md bg-primary/10' : undefined}>
        <Row
          {...(selecting
            ? {}
            : {
                type: 'button' as const,
                'aria-pressed': highlighted,
                onClick: () => setSelected(node.id)
              })}
          data-citation-paper-id={node.id}
          className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted aria-pressed:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-ring"
        >
          {selecting ? (
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-primary"
              aria-label={t('Select {{title}}', { title: node.record.item.title })}
              disabled={saving || statusModel.invalidated || node.conflicting || alreadySaved}
              checked={included}
              onChange={() =>
                setChecked((previous) => {
                  const next = new Set(previous)
                  if (included) node.paperIds.forEach((id) => next.delete(id))
                  else next.add(node.id)
                  return next
                })
              }
            />
          ) : (
            <span
              aria-hidden="true"
              className={`mt-1.5 size-2 shrink-0 rounded-full ${node.relation === 'references' ? 'bg-chart-1' : node.relation === 'citations' ? 'bg-chart-3' : node.relation === 'both' ? 'bg-chart-1 ring-2 ring-chart-3' : 'bg-primary'}`}
            />
          )}
          <span className="min-w-0 space-y-1">
            <span className="block line-clamp-3 text-sm leading-snug">
              {node.record.item.title}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {[
                node.record.item.issuedYear,
                node.record.item.containerTitle,
                creatorLabel(node.record.item)
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {node.conflicting && (
              <span className="block text-xs">{t('Conflicting identifiers')}</span>
            )}
            {selecting && rowReceipt && (
              <span role="status" className="block text-xs text-muted-foreground">
                {receiptLabel(rowReceipt)}
              </span>
            )}
            {node.center ? (
              <span className="block text-xs text-muted-foreground">{t('Current center')}</span>
            ) : null}
          </span>
        </Row>
        {!selecting && selectedNode?.id === node.id ? (
          <div className="px-2 pb-1.5 pl-5">
            <div className="flex items-center gap-1">
              <TooltipProvider disableHoverableContent>
                <PaperAction
                  label={saveLabel}
                  hint={receiptText ?? saveLabel}
                  disabled={saveDisabled}
                  onClick={() => void save()}
                >
                  {saving ? (
                    <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />
                  ) : receipt && receipt !== 'failed' ? (
                    <Check aria-hidden="true" />
                  ) : (
                    <Inbox aria-hidden="true" />
                  )}
                </PaperAction>
                <PaperAction
                  label={t('Set as center')}
                  disabled={centerDisabled}
                  onClick={exploreSelected}
                >
                  <Crosshair aria-hidden="true" />
                </PaperAction>
              </TooltipProvider>
              <Button
                size="sm"
                variant="link"
                className="ml-auto focus-visible:underline"
                onClick={focusDetails}
              >
                {t('View details')}
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
            {receiptText ? (
              <p role="status" className="text-xs text-muted-foreground">
                {receiptText}
              </p>
            ) : null}
          </div>
        ) : null}
      </li>
    )
  }
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
        if (selecting) {
          if (!saving) setChecked(undefined)
          return
        }
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
        {listOpen && (selecting || graph?.nodes.some((node) => !node.center)) && (
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            aria-pressed={selecting}
            onClick={() => setChecked(selecting ? undefined : new Set())}
          >
            <ListChecks aria-hidden="true" />
            {selecting ? t('Done') : t('Select multiple')}
          </Button>
        )}
        {expanded && graph && !selecting ? (
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
              if (listOpen) focusDetails()
              else {
                returnToRow.current = true
                setListOpen(true)
              }
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
                  aria-busy={statusModel.busy === value || undefined}
                  value={value}
                  disabled={
                    model.filter !== 'all' &&
                    (statusModel.interactionBusy || statusModel.invalidated)
                  }
                  className="flex min-w-0 flex-1 items-center justify-center gap-2 border-b-2 border-transparent px-2 py-3 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50 data-[state=active]:border-primary data-[state=active]:text-primary"
                >
                  {value === 'references' ? t('References') : t('Cited by')}
                  {statusModel.busy === value && (
                    <LoaderCircle
                      aria-hidden="true"
                      className="size-3.5 shrink-0 motion-safe:animate-spin"
                    />
                  )}
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
          className={
            listOpen
              ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-pb-14'
              : 'min-h-24 flex-1 overflow-y-auto overscroll-auto px-3 py-3 sm:px-4'
          }
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
            expanded && visible ? (
              <CitationPaperDetails
                paperMetadata={paperMetadata}
                conflicting={selectedNode.conflicting}
                key={selectedNode.record.paperId}
                record={selectedNode.record}
              />
            ) : null
          ) : !selectedNode && !listOpen ? (
            <p className="text-sm text-muted-foreground">
              {t('Select a paper to view its details.')}
            </p>
          ) : null}
          {listOpen && visible ? (
            <section
              className="min-h-full flex flex-col"
              id={`${marker}-paper-list`}
              aria-label={t('Paper list')}
            >
              <LiteratureCitationStatus
                model={statusModel}
                direction={direction}
                selecting={selecting}
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
        {listOpen && selecting && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border-300 bg-card px-3 py-2">
            <span role="status" className="text-xs tabular-nums text-muted-foreground">
              {failedCount
                ? t('Processed: {{saved}} · Failed: {{failed}}', {
                    saved: checkedNodes.length - selectedPapers.length,
                    failed: failedCount
                  })
                : t('Selected: {{selected}}', { selected: selectedPapers.length })}
            </span>
            <Button
              size="sm"
              disabled={blocked || !selectedPapers.length}
              onClick={() => void save(selectedPapers)}
            >
              {retrySelection && !saving ? <RotateCw aria-hidden="true" /> : saveIcon}
              {retrySelection && !saving ? t('Retry') : saveLabel}
            </Button>
          </div>
        )}
        {!listOpen && selectedNode && (!selectedNode.center || temporaryCenter || receipt) ? (
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
                  disabled={centerDisabled}
                  onClick={exploreSelected}
                >
                  <Crosshair aria-hidden="true" />
                  {t('Set as center')}
                </Button>
              ) : null}
              {!selectedNode.center || temporaryCenter ? (
                <Button size="sm" disabled={saveDisabled} onClick={() => void save()}>
                  {saveIcon}
                  {saveLabel}
                </Button>
              ) : null}
            </div>
            {receiptText ? (
              <p role="status" className="text-xs">
                {receiptText}
              </p>
            ) : null}
          </div>
        ) : null}
      </Tabs.Root>
    </section>
  )
}
