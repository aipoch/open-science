import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  LiteratureCatalogReceipt,
  LiteratureItemView
} from '@aipoch/literature-library/contracts'
import {
  literatureRelatedResultSchema,
  type LiteratureRelatedRecord,
  type LiteratureRelatedResult,
  type LiteratureRelatedRequest
} from '@aipoch/literature-discovery/contracts'
import { useLiteratureHost } from '../renderer-host'
import {
  buildCitationGraph,
  supplementedCitation,
  type CitationMetadata,
  filterCitationGraph,
  normalizeCitationPaperId,
  citationRecordProvider,
  type CitationDirection,
  type CitationGraphFilter,
  type CitationGraphEntry,
  type CitationGraph,
  type CitationGraphNode
} from './citation-graph'

export type ScheduleRequest = (
  request: LiteratureRelatedRequest,
  shouldRun: () => boolean
) => Promise<LiteratureRelatedResult>

export type CitationGraphControllerProps = {
  paperMetadata?: CitationMetadata
  item: LiteratureItemView
  onSaved(): void
  onSavingChange?(saving: boolean): void
  disabled?: boolean
  isReferenceInvalidated?: () => boolean
  center?: LiteratureRelatedRecord
  parentToken?: string
  opencitationsMode?: LiteratureRelatedResult['opencitationsMode']
  schedule: ScheduleRequest
  invalidatedSession: React.RefObject<boolean>
  onReferenceChanged(): void
  onRootResolved(record: LiteratureRelatedRecord): void
  onExplore(record: LiteratureRelatedRecord, token: string): void
  directionMode?: 'single' | 'both'
}

export type DirectionState = {
  result?: LiteratureRelatedResult
  pages: number
  nextOffset?: number
  omitted?: number
}
export const citationDirections = ['references', 'citations'] as const

/** Owns one cached center's query lifetime and all catalog writes. Views only invoke commands. */
export function useCitationGraphController({
  item,
  paperMetadata,
  onSaved,
  onSavingChange,
  disabled = false,
  isReferenceInvalidated,
  center,
  parentToken,
  opencitationsMode,
  schedule,
  invalidatedSession,
  onReferenceChanged,
  onRootResolved,
  onExplore,
  directionMode: initialDirectionMode = 'both'
}: CitationGraphControllerProps): CitationGraphController {
  const { api } = useLiteratureHost()
  const directions = citationDirections
  // Bibliographic refreshes do not create a new query lifetime at the same id/revision.
  const localMetadata = useRef(item.item)
  useLayoutEffect(() => {
    localMetadata.current = item.item
  }, [item.item])
  const [seed, setSeed] = useState<LiteratureRelatedRecord>()
  const [entries, setEntries] = useState<CitationGraphEntry[]>([])
  const [filter, setFilter] = useState<CitationGraphFilter>(() =>
    initialDirectionMode === 'single' ? 'references' : 'all'
  )
  const directionMode = filter === 'all' ? 'both' : 'single'
  const activeDirection = filter === 'all' ? 'references' : filter
  const [states, setStates] = useState<Record<CitationDirection, DirectionState>>({
    references: { pages: 0 },
    citations: { pages: 0 }
  })
  const [busy, setBusy] = useState<CitationDirection>()
  const [selected, setSelected] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [receipts, setReceipts] = useState<Record<string, LiteratureCatalogReceipt | 'failed'>>({})
  const active = useRef(true)
  const inFlight = useRef(false)
  const loadedPages = useRef({ references: 0, citations: 0 })
  const savingRef = useRef(false)
  const token = useRef<string | undefined>(undefined)
  const [resolutionToken, setResolutionToken] = useState<string>()
  const seedIdentity = useRef<string | undefined>(undefined)
  const generation = useRef(0)
  const unfilteredGraph = useMemo(
    () => (seed ? buildCitationGraph(seed, entries) : undefined),
    [seed, entries]
  )
  const graph = useMemo(
    () => (unfilteredGraph ? filterCitationGraph(unfilteredGraph, filter) : undefined),
    [unfilteredGraph, filter]
  )
  const selectedNode =
    graph?.nodes.find((node) => node.id === selected || node.paperIds.includes(selected ?? '')) ??
    graph?.nodes[0]
  // Pagination can merge saved nodes under another canonical id; receipts follow native aliases.
  const receiptFor = (node: CitationGraphNode): LiteratureCatalogReceipt | 'failed' | undefined => {
    const matches = node.paperIds.map((id) => receipts[id])
    return (
      matches.find((receipt) => receipt && receipt !== 'failed') ??
      matches.find((receipt) => receipt === 'failed')
    )
  }
  const selectedReceipt = selectedNode && receiptFor(selectedNode)
  const invalidated =
    directionMode === 'single'
      ? ['expired', 'reference-changed'].includes(states[activeDirection].result?.issue ?? '')
      : directions.some((direction) =>
          ['expired', 'reference-changed'].includes(states[direction].result?.issue ?? '')
        )
  const interactionBusy = disabled || busy !== undefined || saving
  const blocked = interactionBusy || invalidated

  const switchDirection = useCallback(
    (next: CitationGraphFilter): void => {
      if (filter === next) return
      const nextGraph = unfilteredGraph && filterCitationGraph(unfilteredGraph, next)
      setSelected((previous) =>
        previous &&
        !nextGraph?.nodes.some((node) => node.id === previous || node.paperIds.includes(previous))
          ? undefined
          : previous
      )
      setFilter(next)
    },
    [filter, unfilteredGraph]
  )

  const load = useCallback(
    async (
      direction: CitationDirection,
      offset = 0,
      resolutionToken?: string,
      current = generation.current
    ): Promise<LiteratureRelatedResult | undefined> => {
      if (
        invalidatedSession.current ||
        isReferenceInvalidated?.() ||
        inFlight.current ||
        loadedPages.current[direction] >= 5 ||
        savingRef.current ||
        !active.current ||
        current !== generation.current
      )
        return
      inFlight.current = true
      setBusy(direction)
      let response: LiteratureRelatedResult
      try {
        response = literatureRelatedResultSchema.parse(
          await schedule(
            {
              itemId: item.id,
              expectedMetadataRevision: item.metadataRevision,
              direction,
              offset,
              resolutionToken: resolutionToken ?? token.current,
              ...(center ? { seedPaperId: normalizeCitationPaperId(center.paperId) } : {})
            },
            () => active.current && current === generation.current
          )
        )
        if (
          response.itemId !== item.id ||
          response.metadataRevision !== item.metadataRevision ||
          response.direction !== direction
        )
          throw new Error('Citation graph identity mismatch.')
        if (response.state === 'ready' && !response.seed)
          throw new Error('Missing citation graph seed.')
        if (
          response.seed &&
          seedIdentity.current &&
          normalizeCitationPaperId(response.seed.paperId) !== seedIdentity.current
        )
          throw new Error('Citation graph seed mismatch.')
      } catch {
        response = {
          itemId: item.id,
          metadataRevision: item.metadataRevision,
          direction,
          state: 'unavailable',
          records: [],
          issue: 'unavailable'
        }
      }
      if (current !== generation.current || !active.current) return
      if (response.issue === 'reference-changed') onReferenceChanged()
      if ((response.state === 'ready' || center) && response.seed && response.resolutionToken) {
        token.current = response.resolutionToken
        setResolutionToken(response.resolutionToken)
        seedIdentity.current = normalizeCitationPaperId(response.seed.paperId)
      }
      if (response.state === 'ready' && response.seed) {
        loadedPages.current[direction]++

        seedIdentity.current = normalizeCitationPaperId(response.seed.paperId)
        token.current = response.resolutionToken
        if (!center) onRootResolved(response.seed)
        const localItem = localMetadata.current
        setSeed(
          (previous) =>
            previous ?? {
              paperId: response.seed!.paperId,
              item: center
                ? response.seed!.item
                : {
                    ...localItem,
                    identifiers: response.seed!.item.identifiers
                  }
            }
        )
        setEntries((previous) => [
          ...previous,
          ...response.records.map((record) => ({ direction, record }))
        ])
      }
      setStates((previous) => ({
        ...previous,
        [direction]: {
          result: response,
          nextOffset:
            response.state === 'ready' ? response.nextOffset : previous[direction].nextOffset,
          omitted:
            (previous[direction].omitted ?? 0) +
            (response.state === 'ready' ? (response.omitted ?? 0) : 0),
          pages: previous[direction].pages + (response.state === 'ready' ? 1 : 0)
        }
      }))
      inFlight.current = false
      setBusy(undefined)
      return response
    },
    [
      schedule,
      item.id,
      item.metadataRevision,
      center,
      invalidatedSession,
      isReferenceInvalidated,
      onReferenceChanged,
      onRootResolved
    ]
  )

  // This effect owns the complete request lifetime. A new center, reset or unmount invalidates it.
  useEffect(() => {
    const counter = generation
    active.current = true
    const current = ++counter.current
    token.current = parentToken

    seedIdentity.current = center ? normalizeCitationPaperId(center.paperId) : undefined
    inFlight.current = false
    loadedPages.current = { references: 0, citations: 0 }
    savingRef.current = false
    queueMicrotask(() => {
      if (!active.current || current !== counter.current) return
      setSeed(undefined)
      setResolutionToken(undefined)
      setEntries([])
      setStates({ references: { pages: 0 }, citations: { pages: 0 } })
      setReceipts({})
      setSelected(undefined)
      setSaving(false)
      const initial = async (): Promise<void> => {
        const response = await load('references', 0, undefined, current)
        if (
          current === counter.current &&
          !['expired', 'reference-changed'].includes(response?.issue ?? '')
        )
          await load('citations', 0, undefined, current)
      }
      void initial()
    })
    return () => {
      active.current = false
      counter.current++
      savingRef.current = false
      onSavingChange?.(false)
    }
  }, [load, parentToken, center, onSavingChange])

  async function save(
    nodes: CitationGraphNode[] = selectedNode ? [selectedNode] : []
  ): Promise<void> {
    if (
      !nodes.length ||
      blocked ||
      savingRef.current ||
      invalidatedSession.current ||
      isReferenceInvalidated?.()
    )
      return
    const current = generation.current
    const isCurrent = (): boolean => current === generation.current && active.current
    savingRef.current = true
    setSaving(true)
    onSavingChange?.(true)
    const results: typeof receipts = {}
    for (const node of nodes) {
      if (!isCurrent() || invalidatedSession.current || isReferenceInvalidated?.()) break
      const previous = receiptFor(node)
      if (node.conflicting || (node.center && !center) || (previous && previous !== 'failed'))
        continue
      let receipt: LiteratureCatalogReceipt | 'failed'
      try {
        const supplemented = supplementedCitation(node.record.item, paperMetadata)
        receipt = await api.literature.transact({
          kind: 'stage-candidate',
          candidate: {
            item: supplemented.item,
            source: {
              provider: citationRecordProvider(node.record.paperId),
              externalId: node.record.paperId,
              sourceUrl: node.record.item.url,
              rawMetadata: {
                ...(supplemented.reference && { metadataLookup: supplemented.reference }),
                ...(node.record.retrievedAt !== undefined
                  ? { retrievedAt: node.record.retrievedAt }
                  : {}),
                rootItemId: item.id,
                rootMetadataRevision: item.metadataRevision,
                ...(citationRecordProvider(node.record.paperId) === 'opencitations'
                  ? { lookupMode: opencitationsMode ?? 'skg-if' }
                  : {}),
                ...(node.center
                  ? {
                      exploredPaperId: node.record.paperId,
                      origin: 'exploration-center'
                    }
                  : {
                      seedPaperId: seed?.paperId,
                      directions: unfilteredGraph?.edges
                        .filter((edge) => edge.source === node.id || edge.target === node.id)
                        .map((edge) => (edge.source === node.id ? 'citations' : 'references'))
                    })
              }
            },
            origin: { kind: 'manual-discovery' }
          }
        })
      } catch {
        receipt = 'failed'
      }
      results[normalizeCitationPaperId(node.id)] = receipt
    }
    // A retired lifetime cannot release the current owner's save lock.
    if (current !== generation.current || !active.current) return
    savingRef.current = false
    setSaving(false)
    onSavingChange?.(false)
    // Recheck after the owner callback, which can synchronously leave this lifetime.
    if (current !== generation.current || !active.current) return
    setReceipts((previous) => ({ ...previous, ...results }))
    if (Object.values(results).some((receipt) => receipt !== 'failed')) onSaved()
  }

  const exploreSelected = (): void => {
    if (
      !blocked &&
      selectedNode &&
      !selectedNode.conflicting &&
      !selectedNode.center &&
      token.current
    )
      onExplore(selectedNode.record, token.current)
  }
  return {
    graph,
    unfilteredGraph,
    filter,
    selected,
    selectedNode,
    setSelected,
    states,
    entries,
    busy,
    saving,
    receipts,
    selectedReceipt,
    receiptFor,
    resolutionToken,
    invalidated,
    interactionBusy,
    blocked,
    load,
    save,
    exploreSelected,
    center,
    item,
    activeDirection,
    setDirection: switchDirection,
    directionMode
  }
}

export type CitationGraphController = {
  graph: CitationGraph | undefined
  unfilteredGraph: CitationGraph | undefined
  filter: CitationGraphFilter
  selected: string | undefined
  selectedNode: CitationGraphNode | undefined
  setSelected: React.Dispatch<React.SetStateAction<string | undefined>>
  states: Record<CitationDirection, DirectionState>
  entries: CitationGraphEntry[]
  busy: CitationDirection | undefined
  saving: boolean
  receipts: Record<string, LiteratureCatalogReceipt | 'failed'>
  selectedReceipt: LiteratureCatalogReceipt | 'failed' | undefined
  resolutionToken: string | undefined
  invalidated: boolean
  interactionBusy: boolean
  blocked: boolean
  load(
    direction: CitationDirection,
    offset?: number,
    resolutionToken?: string,
    current?: number
  ): Promise<LiteratureRelatedResult | undefined>
  receiptFor(node: CitationGraphNode): LiteratureCatalogReceipt | 'failed' | undefined
  save(nodes?: CitationGraphNode[]): Promise<void>
  exploreSelected(): void
  center: LiteratureRelatedRecord | undefined
  item: LiteratureItemView
  activeDirection: CitationDirection
  setDirection(direction: CitationGraphFilter): void
  directionMode: 'single' | 'both'
}
