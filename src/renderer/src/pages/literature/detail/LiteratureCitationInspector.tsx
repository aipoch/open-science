import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, List } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { fullCreatorLabel } from '../literature-item-display'
import type { CitationGraphRelation } from './citation-graph'
import type { CitationGraphController } from './useCitationGraphController'

export type CitationInspectorModel = Pick<
  CitationGraphController,
  'selected' | 'selectedNode' | 'graph' | 'blocked' | 'saving' | 'save' | 'exploreSelected'
> & {
  setSelected(id: string): void
  receipt: CitationGraphController['receipts'][string] | undefined
  temporaryCenter: boolean
  canExplore: boolean
}

export type CitationInspectorHandle = { focus(): void }

export function LiteratureCitationInspector({
  model,
  marker,
  visible,
  expanded,
  onExpandedChange,
  onOpenInbox,
  ref
}: {
  model: CitationInspectorModel
  marker: string
  visible: boolean
  expanded: boolean
  onExpandedChange(expanded: boolean): void
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
  const [listOpen, setListOpen] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
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
  }, [expanded, resetScroll])
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
      focus() {
        setListOpen(false)
        pendingFocus.current = !expanded
        resetScroll()
        inspectorTitle.current?.focus({ preventScroll: true })
      }
    }),
    [expanded, resetScroll]
  )
  const relationLabel = (relation: CitationGraphRelation): string =>
    relation === 'references'
      ? t('References')
      : relation === 'citations'
        ? t('Papers citing this paper')
        : relation === 'both'
          ? t('Both directions')
          : t('Current center')
  const collapse = (): void => {
    setListOpen(false)
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
      className={`flex min-h-0 flex-col overflow-x-hidden overflow-y-auto overscroll-contain border-t border-border-300/80 bg-card/95 shadow-[0_-8px_24px_-20px_hsl(var(--foreground)/.45)] backdrop-blur-sm lg:border-t-0 lg:border-l lg:shadow-[-8px_0_24px_-20px_hsl(var(--foreground)/.45)] ${expanded ? 'sm:max-h-[42vh] lg:max-h-none lg:w-80' : 'lg:w-11'}`}
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border-300/80 bg-muted/20 px-2">
        <Button
          ref={toggle}
          size="sm"
          variant="ghost"
          data-citation-inspector-toggle
          aria-label={t('Selected paper')}
          title={selectedNode?.record.item.title ?? t('Selected paper')}
          aria-expanded={expanded}
          aria-controls={`${marker}-inspector-content`}
          className={`min-w-0 flex-1 justify-start gap-2 ${!expanded ? 'lg:justify-center lg:px-0' : ''}`}
          onClick={() => {
            if (expanded) collapse()
            else {
              setListOpen(false)
              onExpandedChange(true)
            }
          }}
        >
          {expanded ? (
            <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span className={`min-w-0 truncate text-xs ${!expanded ? 'lg:hidden' : ''}`}>
            {expanded ? (
              t('Selected paper')
            ) : (
              <span
                data-citation-inspector-summary
                className="flex min-w-0 flex-col items-start leading-tight"
              >
                <span className="max-w-full truncate">
                  {selectedNode?.record.item.title ?? t('Selected paper')}
                </span>
                {selectedNode ? (
                  <span className="max-w-full truncate text-[10px] font-normal text-muted-foreground">
                    {relationLabel(selectedNode.relation)}
                  </span>
                ) : null}
              </span>
            )}
          </span>
        </Button>
        {expanded && graph ? (
          <Button
            size="icon-sm"
            variant={listOpen ? 'secondary' : 'ghost'}
            data-citation-paper-list-toggle
            aria-label={t('Paper list')}
            title={t('Paper list')}
            aria-expanded={listOpen}
            aria-controls={`${marker}-paper-list`}
            onClick={() => setListOpen((value) => !value)}
          >
            <List className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div
        id={`${marker}-inspector-content`}
        hidden={!expanded}
        className={expanded ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
      >
        <div
          ref={outer}
          data-citation-inspector
          data-citation-graph-scroll
          onScroll={(event) => {
            if (visible) scroll.current = event.currentTarget.scrollTop
          }}
          className="min-h-24 flex-1 overflow-y-auto overscroll-auto px-3 py-3 sm:px-4"
        >
          <h3
            ref={inspectorTitle}
            tabIndex={-1}
            data-citation-inspector-title
            className="mb-2 break-words text-sm font-semibold leading-snug outline-none"
          >
            {selectedNode?.record.item.title ?? t('Selected paper')}
          </h3>
          {selectedNode && !listOpen ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 rounded-xl border border-border-300/70 bg-muted/25 p-3 shadow-sm">
                <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs font-medium">
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
                <p className="inline-flex items-center gap-1.5 rounded-full border border-border-300/80 bg-background/70 px-2.5 py-1 text-xs font-medium text-foreground">
                  <span
                    aria-hidden="true"
                    className={`size-2 rounded-full ${selectedNode.relation === 'references' ? 'bg-chart-1' : selectedNode.relation === 'citations' ? 'bg-chart-3' : selectedNode.relation === 'center' ? 'bg-muted-foreground' : 'bg-chart-1 ring-2 ring-chart-3'}`}
                  />
                  {relationLabel(selectedNode.relation)}
                </p>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
                {selectedNode.record.item.containerTitle ? (
                  <p className="text-xs italic text-muted-foreground">
                    {selectedNode.record.item.containerTitle}
                  </p>
                ) : null}
                <ExternalTextLink
                  href={selectedNode.record.item.url}
                  className="text-xs text-muted-foreground"
                >
                  {t('View source')}
                </ExternalTextLink>
              </div>
              {selectedNode.record.item.abstract ? (
                <details className="rounded-xl border border-border-300/70 bg-muted/15 px-3 py-2 text-sm">
                  <summary className="cursor-pointer font-medium">{t('Abstract')}</summary>
                  <p className="mt-2 whitespace-pre-wrap">{selectedNode.record.item.abstract}</p>
                </details>
              ) : null}
            </div>
          ) : !selectedNode ? (
            <p className="text-sm text-muted-foreground">
              {t('Select a paper to view its details.')}
            </p>
          ) : null}
          {graph && listOpen ? (
            <section
              id={`${marker}-paper-list`}
              aria-label={t('Paper list')}
              className="border-t border-border-300 pt-3"
            >
              <h4 className="mb-2 text-xs font-medium">{t('Paper list')}</h4>
              <ol className="space-y-1">
                {graph.nodes.map((node, index) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      aria-pressed={selectedNode?.id === node.id}
                      className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-muted aria-pressed:bg-muted focus-visible:outline-ring"
                      onClick={() => {
                        setSelected(node.id)
                        setListOpen(false)
                        resetScroll()
                        inspectorTitle.current?.focus({ preventScroll: true })
                      }}
                    >{`${index + 1}. ${node.record.item.title}`}</button>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>
        {selectedNode && (!selectedNode.center || temporaryCenter || receipt || onOpenInbox) ? (
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
            {onOpenInbox ? (
              <div data-citation-inspector-secondary-actions className="flex items-center">
                <Button size="sm" variant="ghost" disabled={saving} onClick={onOpenInbox}>
                  {t('Open Inbox')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
