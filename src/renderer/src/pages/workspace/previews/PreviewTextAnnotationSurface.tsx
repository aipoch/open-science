import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, ListCollapse, MessageCircleQuestionMark, Quote } from 'lucide-react'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { Annotation, PdfAnnotation, TextAnnotation } from '../../../../../shared/annotations'
import { parseUploadVersionReference } from '../../../../../shared/uploads'
import type { PreviewFileRendererProps } from './preview-types'
import {
  revealTextAnnotationRange,
  subscribeAnnotationReveal
} from '../annotations/annotation-reveal'
import { isBackwardSelection } from '../annotations/annotation-trigger-anchor'
import { createAnnotationId } from '../annotations/annotation-id'
import {
  AnnotationDraftEditor,
  AnnotationMarkers,
  type AnnotationControl
} from '../annotations/TextAnnotationEditors'
import type { AnnotationTriggerAction } from '../annotations/AnnotationTrigger'
import {
  pdfTextSelectorForRange,
  quoteOccurrenceForRange,
  reconcileTextAnnotationRanges,
  retargetTextAnnotationRange
} from '../annotations/text-annotation-range'

type RangeAnnotation = TextAnnotation

type SelectionDraft = Readonly<{
  quote: string
  backward: boolean
  range: Range
  occurrence: number
}>

type PdfSelectionSegment = Readonly<{
  text: string
  rect: DOMRect
  fontSize: number
  position: 'normal' | 'superscript' | 'subscript'
}>

const DRAFT_HIGHLIGHT_NAME = 'preview-annotation-draft'
const DRAFT_HIGHLIGHT_STYLE_ID = 'preview-annotation-draft-style'
const NO_ANNOTATIONS: readonly never[] = []

// Pointer interactions owned by the annotate UI itself; a pointerdown inside
// these must not clear the draft (the browser collapses the selection on any
// mousedown, so the draft can only survive through an exemption).
const ANNOTATE_UI_SELECTOR =
  '[data-annotation-trigger], [data-selection-action-menu], [data-radix-popper-content-wrapper]'

const characterMap = (source: string, formatted: string): ReadonlyMap<string, string> =>
  new Map([...source].map((character, index) => [character, [...formatted][index]!]))
const SUPERSCRIPT = characterMap('0123456789+-=()n', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ')
const SUBSCRIPT = characterMap(
  '0123456789+-=()aehijklmnoprstuvx',
  '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ'
)

const selectedTextFromNode = (range: Range, node: Text): string => {
  if (!range.intersectsNode(node)) return ''
  const start = range.startContainer === node ? range.startOffset : 0
  const end = range.endContainer === node ? range.endOffset : node.data.length
  return node.data.slice(start, end)
}

const horizontalGap = (left: DOMRect, right: DOMRect): number =>
  Math.max(0, left.left - right.right, right.left - left.right)

const pdfSelectionSegments = (surface: HTMLElement, range: Range): PdfSelectionSegment[] => {
  const segments: Omit<PdfSelectionSegment, 'position'>[] = []
  const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text
    const text = selectedTextFromNode(range, textNode)
    const span = textNode.parentElement?.closest<HTMLSpanElement>('[data-pdf-text-layer] span')
    if (!text || !span || !surface.contains(span)) continue
    const rect = span.getBoundingClientRect()
    const computedFontSize = Number.parseFloat(getComputedStyle(span).fontSize)
    segments.push({
      text,
      rect,
      fontSize:
        Number.isFinite(computedFontSize) && computedFontSize > 0 ? computedFontSize : rect.height
    })
  }

  return segments.map((segment) => {
    const reference = segments
      .filter((candidate) => {
        if (candidate === segment || candidate.fontSize < segment.fontSize * 1.12) return false
        const overlap =
          Math.min(segment.rect.bottom, candidate.rect.bottom) -
          Math.max(segment.rect.top, candidate.rect.top)
        return (
          overlap > 0 && horizontalGap(segment.rect, candidate.rect) <= candidate.rect.height * 4
        )
      })
      .sort(
        (left, right) =>
          horizontalGap(segment.rect, left.rect) - horizontalGap(segment.rect, right.rect)
      )[0]
    if (!reference) return { ...segment, position: 'normal' as const }
    const baselineDelta = segment.rect.bottom - reference.rect.bottom
    const threshold = Math.max(1, reference.rect.height * 0.1)
    return {
      ...segment,
      position:
        baselineDelta < -threshold
          ? ('superscript' as const)
          : baselineDelta > threshold
            ? ('subscript' as const)
            : ('normal' as const)
    }
  })
}

const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const formattedPlainText = (value: string, position: PdfSelectionSegment['position']): string => {
  if (position === 'normal') return value
  const characters = [...value]
  const mapping = position === 'superscript' ? SUPERSCRIPT : SUBSCRIPT
  const mapped = characters.map((character) => mapping.get(character))
  if (mapped.every((character) => character !== undefined)) return mapped.join('')
  return `${position === 'superscript' ? '^' : '_'}(${value})`
}

const pdfClipboardContent = (
  surface: HTMLElement,
  range: Range,
  fallbackText: string
): Readonly<{ plainText: string; html: string }> => {
  const segments = pdfSelectionSegments(surface, range)
  if (
    segments.length === 0 ||
    segments
      .map(({ text }) => text)
      .join('')
      .trim() !== fallbackText
  ) {
    return { plainText: fallbackText, html: `<span>${escapeHtml(fallbackText)}</span>` }
  }
  return {
    plainText: segments
      .map(({ text, position }) => formattedPlainText(text, position))
      .join('')
      .trim(),
    html: `<span style="white-space: pre-wrap">${segments
      .map(({ text, position }) => {
        const escaped = escapeHtml(text)
        if (position === 'superscript') return `<sup>${escaped}</sup>`
        if (position === 'subscript') return `<sub>${escaped}</sub>`
        return escaped
      })
      .join('')}</span>`
  }
}

const projectFileVersionId = (item: PreviewFileItem): string | undefined =>
  item.selectedVersionId ??
  (item.source === 'upload' ? parseUploadVersionReference(item.path)?.versionId : undefined)

const projectFileSource = (
  item: PreviewFileItem,
  pageNumber?: number
): TextAnnotation['source'] | undefined => {
  if (!item.projectId || pageNumber !== undefined) return undefined
  const versionId = projectFileVersionId(item)
  return {
    kind: 'project-file',
    projectId: item.projectId,
    path: item.path,
    name: item.name,
    ...(versionId ? { versionId } : {}),
    ...(item.sessionId ? { sessionId: item.sessionId } : {})
  }
}

const belongsToPreview = (
  annotation: RangeAnnotation,
  item: PreviewFileItem,
  pageNumber?: number
): boolean => {
  const source = annotation.source
  if (source.kind !== 'project-file' || !item.projectId) return false
  if (source.projectId !== item.projectId || source.path !== item.path) return false
  const versionId = projectFileVersionId(item)
  if (source.versionId || versionId) {
    if (source.versionId !== versionId) return false
  }
  return pageNumber === undefined
}

const getDraftHighlight = (): Highlight | undefined => {
  if (typeof Highlight === 'undefined' || !globalThis.CSS?.highlights) return undefined
  if (!document.getElementById(DRAFT_HIGHLIGHT_STYLE_ID)) {
    const style = document.createElement('style')
    style.id = DRAFT_HIGHLIGHT_STYLE_ID
    style.textContent = `::highlight(${DRAFT_HIGHLIGHT_NAME}) {
      background-color: color-mix(in oklab, var(--primary) 22%, transparent);
      text-decoration: underline 0.125rem var(--primary);
    }`
    document.head.appendChild(style)
  }
  const current = CSS.highlights.get(DRAFT_HIGHLIGHT_NAME)
  if (current) return current
  const created = new Highlight()
  CSS.highlights.set(DRAFT_HIGHLIGHT_NAME, created)
  return created
}

export const PreviewTextAnnotationSurface = ({
  item,
  activeAnnotations = NO_ANNOTATIONS,
  onAddAnnotation,
  onUpdateAnnotationNote,
  onAnnotationError,
  sourcePageNumber,
  pdfEvidenceSource,
  pdfExtractorVersion,
  onAnnotationAdded,
  children
}: PreviewFileRendererProps & {
  sourcePageNumber?: number
  pdfEvidenceSource?: PdfAnnotation['source']
  pdfExtractorVersion?: string
  onAnnotationAdded?: () => void
  children: React.ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const ownedRanges = useRef(new Map<string, Range>())
  const pendingRangeRef = useRef<Range | null>(null)
  const copiedResetRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [selection, setSelection] = useState<SelectionDraft>()
  const selectionRef = useRef(selection)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState(false)
  const [annotationControls, setAnnotationControls] = useState<readonly AnnotationControl[]>([])
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string>()
  const source = projectFileSource(item, sourcePageNumber)
  const matchingAnnotations = useMemo(
    () =>
      activeAnnotations.filter(
        (annotation): annotation is RangeAnnotation =>
          annotation.kind === 'text' && belongsToPreview(annotation, item, sourcePageNumber)
      ),
    [activeAnnotations, item, sourcePageNumber]
  )

  const measureAnnotationControls = useCallback((): void => {
    const surface = surfaceRef.current
    if (!surface) return
    const surfaceRect = surface.getBoundingClientRect()
    setAnnotationControls(
      matchingAnnotations.flatMap((annotation) => {
        const range = ownedRanges.current.get(annotation.id)
        if (!range) return []
        const rects = Array.from(range.getClientRects?.() ?? [])
        const rect =
          rects.at(-1) ??
          (typeof range.getBoundingClientRect === 'function'
            ? range.getBoundingClientRect()
            : undefined)
        if (!rect || (rect.width === 0 && rect.height === 0)) return []
        return [
          {
            annotation,
            left: rect.right - surfaceRect.left,
            top: rect.top - surfaceRect.top
          }
        ]
      })
    )
  }, [matchingAnnotations])

  const trackAnnotatedTextHover = (event: React.PointerEvent<HTMLDivElement>): void => {
    const hovered = matchingAnnotations.find((annotation) => {
      const range = ownedRanges.current.get(annotation.id)
      return Array.from(range?.getClientRects?.() ?? []).some(
        (rect) =>
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
      )
    })
    setHoveredAnnotationId((current) => (current === hovered?.id ? current : hovered?.id))
  }

  useLayoutEffect(() => {
    selectionRef.current = selection
  }, [selection])

  const retargetDraftSelection = useCallback((): void => {
    const content = contentRef.current
    const draft = selectionRef.current
    if (!content || !draft) return
    const nextRange = retargetTextAnnotationRange(
      content,
      draft.quote,
      draft.range,
      draft.occurrence
    )
    if (nextRange === draft.range) return
    if (nextRange) {
      setSelection({ ...draft, range: nextRange })
      return
    }
    setSelection(undefined)
    setOpen(false)
    setNote('')
  }, [])

  const reconcilePreviewHighlights = useCallback((): void => {
    const highlight = getDraftHighlight()
    if (!highlight) return
    for (const range of ownedRanges.current.values()) highlight.delete(range)
    const content = contentRef.current
    if (!content) {
      ownedRanges.current.clear()
      return
    }
    ownedRanges.current = reconcileTextAnnotationRanges(
      content,
      matchingAnnotations.map((annotation) => ({
        id: annotation.id,
        quote: annotation.quote
      })),
      ownedRanges.current
    )
    for (const range of ownedRanges.current.values()) highlight.add(range)
    measureAnnotationControls()
  }, [matchingAnnotations, measureAnnotationControls])

  useLayoutEffect(() => {
    reconcilePreviewHighlights()
    retargetDraftSelection()
  }, [children, reconcilePreviewHighlights, retargetDraftSelection])

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content || typeof MutationObserver === 'undefined') return
    let scheduled = false
    let disconnected = false
    const observer = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (disconnected) return
        reconcilePreviewHighlights()
        retargetDraftSelection()
      })
    })
    observer.observe(content, { childList: true, characterData: true, subtree: true })
    return () => {
      disconnected = true
      observer.disconnect()
    }
  }, [reconcilePreviewHighlights, retargetDraftSelection])

  useEffect(() => {
    window.addEventListener('resize', measureAnnotationControls)
    return () => window.removeEventListener('resize', measureAnnotationControls)
  }, [measureAnnotationControls])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureAnnotationControls)
    observer.observe(surface)
    if (surface.firstElementChild) observer.observe(surface.firstElementChild)
    return () => observer.disconnect()
  }, [measureAnnotationControls])

  useLayoutEffect(
    () => () => {
      if (copiedResetRef.current) clearTimeout(copiedResetRef.current)
      const highlight = getDraftHighlight()
      if (!highlight) return
      for (const range of ownedRanges.current.values()) highlight.delete(range)
      ownedRanges.current.clear()
      if (pendingRangeRef.current) {
        highlight.delete(pendingRangeRef.current)
        pendingRangeRef.current = null
      }
    },
    []
  )

  // Opening the note editor collapses the native selection; the quoted text
  // must stay visible through the draft highlight until the draft resolves,
  // so the editor itself never needs to repeat the quote.
  useLayoutEffect(() => {
    const highlight = getDraftHighlight()
    if (!highlight) return
    if (open && selection) {
      if (pendingRangeRef.current && pendingRangeRef.current !== selection.range) {
        highlight.delete(pendingRangeRef.current)
      }
      highlight.add(selection.range)
      pendingRangeRef.current = selection.range
    } else if (pendingRangeRef.current) {
      highlight.delete(pendingRangeRef.current)
      pendingRangeRef.current = null
    }
  }, [open, selection])

  const clearDraft = useCallback((): void => {
    // Only the surface whose editor is open owns a stale native selection
    // (a keyboard-opened editor never let the browser collapse it); clearing
    // it unconditionally would destroy a selection another surface is
    // building with this very pointerdown.
    if (open) window.getSelection()?.removeAllRanges()
    if (copiedResetRef.current) clearTimeout(copiedResetRef.current)
    setSelection(undefined)
    setOpen(false)
    setNote('')
    setCopied(false)
  }, [open])

  const captureSelection = (): void => {
    // While the note editor is open the draft is frozen; stray mouseup/keyup
    // events from the surface must neither replace nor drop it.
    if (open) return
    if ((!source && !pdfEvidenceSource) || !onAddAnnotation) {
      clearDraft()
      return
    }
    const selected = window.getSelection()
    const range = selected?.rangeCount ? selected.getRangeAt(0) : undefined
    const surface = surfaceRef.current
    if (!selected || !range || !surface || selected.isCollapsed) {
      clearDraft()
      return
    }
    const ancestor = range.commonAncestorContainer
    if (!surface.contains(ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor)) {
      clearDraft()
      return
    }
    const quote = selected.toString().trim()
    if (!quote) {
      clearDraft()
      return
    }
    const cloned = range.cloneRange()
    const content = contentRef.current
    const occurrence = content ? quoteOccurrenceForRange(content, quote, cloned) : 0
    const exactRange = content
      ? (retargetTextAnnotationRange(content, quote, cloned, occurrence) ?? cloned)
      : cloned
    setSelection({
      quote,
      backward: isBackwardSelection(selected),
      range: exactRange,
      occurrence
    })
  }

  useEffect(() => {
    // Clicking anywhere else collapses the selection without any event
    // reaching this surface; the draft must follow the real selection
    // instead of lingering over the text as a stale trigger.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest(ANNOTATE_UI_SELECTOR)) return
      clearDraft()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [clearDraft])

  useEffect(
    () =>
      // The composer card reveals a quote by id; only the surface owning that
      // annotation's range answers.
      subscribeAnnotationReveal((annotationId) => {
        const range = ownedRanges.current.get(annotationId)
        if (!range) return false
        revealTextAnnotationRange(range)
        return true
      }),
    []
  )

  const add = (noteValue = note): void => {
    if (!selection || (!source && !pdfEvidenceSource) || !onAddAnnotation) return
    const pdfSelector =
      pdfEvidenceSource && sourcePageNumber !== undefined && pdfExtractorVersion
        ? pdfTextSelectorForRange(
            contentRef.current!,
            selection.range,
            sourcePageNumber,
            pdfExtractorVersion,
            surfaceRef.current!
          )
        : undefined
    const annotation: Annotation = pdfSelector
      ? {
          id: createAnnotationId(),
          kind: 'pdf',
          target: 'agent',
          ...(noteValue.trim() ? { note: noteValue.trim() } : {}),
          source: pdfEvidenceSource!,
          selector: pdfSelector
        }
      : {
          id: createAnnotationId(),
          kind: 'text',
          target: 'agent',
          quote: selection.quote,
          ...(noteValue.trim() ? { note: noteValue.trim() } : {}),
          source: source!
        }
    const error = onAddAnnotation(annotation)
    if (error) {
      onAnnotationError?.(error)
      return
    }
    const highlight = getDraftHighlight()
    if (annotation.kind === 'text') {
      highlight?.add(selection.range)
      ownedRanges.current.set(annotation.id, selection.range)
    }
    // The range now belongs to the confirmed annotation; clearing the draft
    // below must not withdraw the highlight it just adopted.
    pendingRangeRef.current = null
    clearDraft()
    window.getSelection()?.removeAllRanges()
    onAnnotationAdded?.()
  }

  const copySelection = useCallback(async (): Promise<void> => {
    const clipboard = navigator.clipboard
    if (!selection || !clipboard) return
    const contentSurface = contentRef.current
    const content =
      pdfEvidenceSource && contentSurface
        ? pdfClipboardContent(contentSurface, selection.range, selection.quote)
        : { plainText: selection.quote, html: undefined }
    try {
      if (clipboard.write && typeof ClipboardItem !== 'undefined') {
        try {
          await clipboard.write([
            new ClipboardItem({
              'text/plain': new Blob([content.plainText], { type: 'text/plain' }),
              ...(content.html
                ? { 'text/html': new Blob([content.html], { type: 'text/html' }) }
                : {})
            })
          ])
        } catch {
          if (!clipboard.writeText) throw new Error('Clipboard write failed')
          await clipboard.writeText(content.plainText)
        }
      } else {
        if (!clipboard.writeText) return
        await clipboard.writeText(content.plainText)
      }
      setCopied(true)
      if (copiedResetRef.current) clearTimeout(copiedResetRef.current)
      copiedResetRef.current = setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }, [pdfEvidenceSource, selection])

  const canCopy = Boolean(navigator.clipboard)

  const triggerActions: readonly AnnotationTriggerAction[] | undefined = pdfEvidenceSource
    ? [
        {
          id: 'citate',
          label: t('Citate'),
          icon: Quote,
          showLabel: true,
          primary: true,
          onActivate: () => add('')
        },
        {
          id: 'explain',
          label: t('Explain'),
          icon: MessageCircleQuestionMark,
          onActivate: () => add(t('Explain this passage.'))
        },
        {
          id: 'summarize',
          label: t('Summarize'),
          icon: ListCollapse,
          onActivate: () => add(t('Summarize this passage.'))
        },
        {
          id: 'copy',
          label: copied ? t('Copied') : t('Copy'),
          icon: copied ? Check : Copy,
          disabled: !canCopy,
          onActivate: () => void copySelection()
        }
      ]
    : undefined

  return (
    <div
      ref={surfaceRef}
      data-preview-text-annotation-surface="true"
      data-annotation-active={matchingAnnotations.length > 0 ? 'true' : undefined}
      className="relative size-full rounded-md"
      onMouseUp={captureSelection}
      onKeyUp={captureSelection}
      onScrollCapture={measureAnnotationControls}
      onPointerMove={trackAnnotatedTextHover}
      onPointerLeave={() => setHoveredAnnotationId(undefined)}
    >
      <div ref={contentRef} className="contents">
        {children}
      </div>
      <AnnotationMarkers
        controls={annotationControls}
        hoveredAnnotationId={hoveredAnnotationId}
        variant="preview"
        onUpdateNote={onUpdateAnnotationNote}
        onError={onAnnotationError}
      />
      {matchingAnnotations.length > 0 ? (
        <span className="sr-only">{t('Annotated for Agent')}</span>
      ) : null}
      {selection ? (
        <AnnotationDraftEditor
          range={selection.range}
          backward={selection.backward}
          open={open}
          note={note}
          noteInputId={`preview-note-${item.id}`}
          variant="preview"
          onOpenChange={(next) => {
            setOpen(next)
            if (!next) {
              setNote('')
              // Escape keeps the draft (the trigger returns) but must still
              // withdraw a keyboard-triggered native selection.
              window.getSelection()?.removeAllRanges()
            }
          }}
          onCancel={() => setOpen(false)}
          onNoteChange={setNote}
          onAdd={() => add()}
          triggerActions={triggerActions}
        />
      ) : null}
    </div>
  )
}
