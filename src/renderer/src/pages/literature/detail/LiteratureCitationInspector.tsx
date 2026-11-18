import { CitationAbstract } from './LiteratureDetailText'
import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, List, Inbox } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { fullCreatorLabel, getExternalLiteratureUrl } from '../literature-item-display'
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
      className={`flex min-h-0 flex-col overflow-x-hidden overflow-y-auto overscroll-contain border-t border-border-300 bg-background lg:border-t-0 lg:border-l ${expanded ? 'sm:max-h-[42vh] lg:max-h-none lg:w-80' : 'lg:w-11'}`}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border-300 px-2">
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
            className="mb-4 break-words text-base font-semibold leading-snug outline-none"
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
      </div>
    </section>
  )
}
