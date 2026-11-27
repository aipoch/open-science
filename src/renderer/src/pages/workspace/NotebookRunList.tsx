import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject
} from 'react'

import { flushSync } from 'react-dom'
import type { NotebookRunRecord } from '../../../../shared/notebook'

export type NotebookCellDisclosure = Map<'output' | 'evidence', boolean>
type ReadingAnchor = { id: string; offset: number }
export type NotebookRunListHandle = {
  capture: () => ReadingAnchor | undefined
  restore: (anchor: ReadingAnchor) => boolean
  reveal: (id: string) => boolean
}

const runElement = (node: Node | null): HTMLElement | null =>
  (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-run-id]') ??
  null

export function NotebookRunList({
  runs,
  viewportRef,
  followOnMount,
  active,
  ref,
  renderRun
}: {
  runs: NotebookRunRecord[]
  viewportRef: RefObject<HTMLDivElement | null>
  active: boolean
  followOnMount?: RefObject<boolean>
  ref: Ref<NotebookRunListHandle>
  renderRun: (
    run: NotebookRunRecord,
    index: number,
    disclosure: NotebookCellDisclosure
  ) => ReactNode
}): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  const disclosures = useRef(new Map<string, NotebookCellDisclosure>())
  const [margin, setMargin] = useState(0)
  const [finding, setFinding] = useState(false)
  const enabled = runs.length > 16 && !finding
  const indices = useMemo(() => new Map(runs.map((run, index) => [run.runId, index])), [runs])
  const [restoringId, setRestoringId] = useState<string>()
  const firstId = runs[0]?.runId ?? ''
  const lastId = runs.at(-1)?.runId ?? ''
  const [pins, setPins] = useState<string[]>([])
  useLayoutEffect(() => {
    const element = list.current
    if (!element || !enabled) return
    const pin = (): void => {
      const selection = document.getSelection()
      const id = (node: Node | null): string =>
        node && element.contains(node) ? (runElement(node)?.dataset.runId ?? '') : ''
      const range =
        selection && !selection.isCollapsed && selection.rangeCount
          ? selection.getRangeAt(0)
          : undefined
      const intersects = range?.intersectsNode(element)
      const first = intersects ? id(range!.startContainer) || firstId : ''
      const last = intersects ? id(range!.endContainer) || lastId : ''
      const next = [id(document.activeElement), first, last]
      setPins((previous) => (next.every((value, i) => value === previous[i]) ? previous : next))
    }
    document.addEventListener('selectionchange', pin)
    document.addEventListener('focusin', pin)
    pin()
    return () => {
      document.removeEventListener('selectionchange', pin)
      document.removeEventListener('focusin', pin)
    }
  }, [enabled, firstId, lastId])
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const items = new Set(defaultRangeExtractor(range))
      const restoring = restoringId && indices.get(restoringId)
      if (typeof restoring === 'number') items.add(restoring)
      const [focus, start, end] = pins.map((id) => indices.get(id))
      if (focus !== undefined) items.add(focus)
      if (start !== undefined && end !== undefined) {
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++) items.add(i)
      }
      return [...items].sort((a, b) => a - b)
    },
    [pins, indices, restoringId]
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- Virtualizer reads live DOM measurements.
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: runs.length,
    getScrollElement: () =>
      list.current?.closest<HTMLDivElement>('[data-notebook-viewport]') ?? null,
    initialOffset: () => viewportRef.current?.scrollTop ?? 0,
    getItemKey: useCallback((i: number) => runs[i].runId, [runs]),
    estimateSize: () => 220,
    overscan: 4,
    scrollMargin: margin,
    enabled,
    rangeExtractor
  })
  useLayoutEffect(() => {
    const element = list.current
    if (!enabled || !element) return
    const sync = (): void => setMargin(element.offsetTop)
    sync()
    const header = element.previousElementSibling
    if (!header || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(sync)
    observer.observe(header)
    return () => observer.disconnect()
  }, [enabled])

  const pending = useRef<ReadingAnchor | undefined>(undefined)
  const navigation = useRef<NotebookRunListHandle | null>(null)
  const wasEnabled = useRef(false)
  useLayoutEffect(() => {
    if (enabled && !wasEnabled.current && followOnMount?.current && !pending.current)
      virtualizer.scrollToEnd()
    wasEnabled.current = enabled
  }, [enabled, followOnMount, virtualizer])
  useLayoutEffect(() => {
    const show = window.api?.window?.onShowWindowFind?.(() => {
      if (!active || !list.current?.getClientRects().length || finding) return
      const anchor = navigation.current?.capture()
      // The transcript owns the Electron readiness handshake. Make loaded Notebook
      // text searchable in this IPC turn before the overlay can issue a find.
      flushSync(() => setFinding(true))
      if (anchor) navigation.current?.restore(anchor)
    })
    const hide = window.api?.window?.onHideWindowFind?.(() => {
      if (!finding) return
      const anchor = navigation.current?.capture()
      pending.current = anchor
      flushSync(() => setFinding(false))
      if (anchor) navigation.current?.restore(anchor)
    })
    return () => {
      show?.()
      hide?.()
    }
  }, [active, finding])
  const restoreMounted = useCallback(
    (anchor: ReadingAnchor): boolean => {
      const viewport = viewportRef.current
      const row = list.current?.querySelector<HTMLElement>(
        '[data-run-id="' + CSS.escape(anchor.id) + '"]'
      )
      if (!viewport || !row) return false
      const delta =
        row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset
      if (Math.abs(delta) > 0.5) viewport.scrollTop += delta
      return true
    },
    [viewportRef]
  )
  // Pin the reading row while the newly mounted neighbours replace their estimated
  // heights. Core measurements and React's positioned rows can land in different frames.
  useLayoutEffect(() => {
    if (!restoringId || !enabled) return
    const viewport = viewportRef.current
    if (!viewport) return
    let frame = 0
    let stableFrames = 0
    let previousHeight = -1
    const finish = (): void => {
      pending.current = undefined
      setRestoringId(undefined)
      cancelAnimationFrame(frame)
    }
    const settle = (): void => {
      const anchor = pending.current
      if (!anchor || !indices.has(anchor.id)) return finish()
      const top = viewport.scrollTop
      const found = restoreMounted(anchor)
      const height = viewport.scrollHeight
      stableFrames =
        found && previousHeight === height && Math.abs(viewport.scrollTop - top) <= 0.5
          ? stableFrames + 1
          : 0
      previousHeight = height
      if (stableFrames >= 3) finish()
      else frame = requestAnimationFrame(settle)
    }
    settle()
    const intents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
    for (const event of intents) viewport.addEventListener(event, finish, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      for (const event of intents) viewport.removeEventListener(event, finish)
    }
  }, [enabled, indices, restoreMounted, restoringId, viewportRef])
  useLayoutEffect(() => {
    if (pending.current) restoreMounted(pending.current)
  })
  useImperativeHandle(navigation, () => ({
    capture() {
      const viewport = viewportRef.current
      if (!viewport) return
      const bounds = viewport.getBoundingClientRect()
      for (const row of list.current?.querySelectorAll<HTMLElement>('[data-run-id]') ?? []) {
        const rect = row.getBoundingClientRect()
        if (rect.bottom > bounds.top && rect.top < bounds.bottom)
          return { id: row.dataset.runId!, offset: rect.top - bounds.top }
      }
      return undefined
    },
    restore(anchor) {
      const index = indices.get(anchor.id)
      if (index === undefined) return false
      if (!enabled) return restoreMounted(anchor)
      pending.current = anchor
      setRestoringId(anchor.id)
      restoreMounted(anchor)
      return true
    },
    reveal(id) {
      pending.current = undefined
      setRestoringId(undefined)
      const index = indices.get(id)
      if (index === undefined) return false
      if (enabled) virtualizer.scrollToIndex(index, { align: 'center' })
      else {
        const row = [...(list.current?.children ?? [])].find(
          (node) => (node as HTMLElement).dataset.runId === id
        )
        if (!row?.scrollIntoView) return false
        row.scrollIntoView({ block: 'center' })
      }
      return true
    }
  }))
  useImperativeHandle(ref, () => navigation.current!)
  const render = (index: number, start?: number): React.JSX.Element => {
    const run = runs[index]
    let state = disclosures.current.get(run.runId)
    if (!state) {
      state = new Map()
      disclosures.current.set(run.runId, state)
    }
    return (
      <div
        key={run.runId}
        data-run-id={run.runId}
        data-index={index}
        ref={enabled ? virtualizer.measureElement : undefined}
        className={index > 0 ? 'border-t border-border-100' : undefined}
        style={
          start === undefined
            ? undefined
            : {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${start - margin}px)`
              }
        }
      >
        {renderRun(run, index, state)}
      </div>
    )
  }
  return (
    <div
      ref={list}
      style={enabled ? { position: 'relative', height: virtualizer.getTotalSize() } : undefined}
    >
      {enabled
        ? virtualizer.getVirtualItems().map((row) => render(row.index, row.start))
        : runs.map((_, index) => render(index))}
    </div>
  )
}
