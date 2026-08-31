// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  requestAnnotationReveal,
  annotationRevealScrollBehavior,
  revealTextAnnotationRange,
  subscribeAnnotationReveal,
  subscribeAnnotationRevealPreparation
} from './annotation-reveal'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore,
  type PreviewFileItem
} from '@/stores/preview-workbench-store'
import type { Annotation } from '../../../../../shared/annotations'

class TestHighlight extends Set<Range> {}

describe('annotation reveal', () => {
  let highlights: Map<string, TestHighlight>
  let paragraph: HTMLParagraphElement

  beforeEach(() => {
    vi.useFakeTimers()
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    usePreviewWorkbenchStore.getState().activateProject('project-1')
    highlights = new Map()
    vi.stubGlobal('Highlight', TestHighlight)
    vi.stubGlobal('CSS', { highlights })
    paragraph = document.createElement('p')
    paragraph.textContent = 'quoted evidence stays visible'
    document.body.appendChild(paragraph)
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    paragraph.remove()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })

  const textRange = (): Range => {
    const range = document.createRange()
    range.selectNodeContents(paragraph.firstChild!)
    return range
  }

  const agentAnnotation = (id: string): Annotation => ({
    id,
    kind: 'text',
    target: 'agent',
    quote: 'quoted evidence',
    source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }
  })

  it('scrolls to the range and flashes a stronger highlight', () => {
    revealTextAnnotationRange(textRange())

    expect(paragraph.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
    const revealed = Array.from(highlights.get('agent-annotation-reveal') ?? [])
    expect(revealed.map((range) => range.toString())).toContain('quoted evidence stays visible')

    vi.advanceTimersByTime(1_600)
    expect(Array.from(highlights.get('agent-annotation-reveal') ?? [])).toHaveLength(0)
  })

  it('avoids smooth reveal scrolling when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))

    expect(annotationRevealScrollBehavior()).toBe('auto')
    revealTextAnnotationRange(textRange())
    expect(paragraph.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' })
  })

  it('replaces an earlier reveal instead of stacking ranges', () => {
    revealTextAnnotationRange(textRange())
    revealTextAnnotationRange(textRange())
    expect(Array.from(highlights.get('agent-annotation-reveal') ?? [])).toHaveLength(1)

    vi.advanceTimersByTime(1_600)
    expect(Array.from(highlights.get('agent-annotation-reveal') ?? [])).toHaveLength(0)
  })

  it('delivers reveal requests from composer cards to subscribers', () => {
    const listener = vi.fn(() => true)
    const unsubscribe = subscribeAnnotationReveal(listener)

    requestAnnotationReveal(agentAnnotation('annotation-1'))
    expect(listener).toHaveBeenCalledWith('annotation-1')

    unsubscribe()
    requestAnnotationReveal(agentAnnotation('annotation-2'))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('prepares session content with the complete annotation before publishing its id', () => {
    const annotation = agentAnnotation('annotation-prepared')
    const order: string[] = []
    const clearPending = subscribeAnnotationReveal(() => true)
    clearPending()
    const unsubscribePreparation = subscribeAnnotationRevealPreparation((prepared) => {
      order.push(`prepare:${prepared.id}`)
      expect(prepared).toBe(annotation)
    })
    const unsubscribeReveal = subscribeAnnotationReveal((annotationId) => {
      order.push(`reveal:${annotationId}`)
      return true
    })

    requestAnnotationReveal(annotation)

    expect(order).toEqual(['prepare:annotation-prepared', 'reveal:annotation-prepared'])
    unsubscribeReveal()
    unsubscribePreparation()
  })

  it('delivers a pending text reveal when its file surface mounts after tab activation', () => {
    requestAnnotationReveal({
      id: 'annotation-late',
      kind: 'text',
      target: 'agent',
      quote: 'late file quote',
      source: {
        kind: 'project-file',
        projectId: 'project-1',
        sessionId: 'session-1',
        path: '/project/notes.md',
        name: 'notes.md'
      }
    })

    const listener = vi.fn(() => true)
    const unsubscribe = subscribeAnnotationReveal(listener)

    expect(listener).toHaveBeenCalledWith('annotation-late')
    unsubscribe()
  })

  it('keeps PDF page preparation available until the page text layer can mount', () => {
    const annotation: Annotation = {
      id: 'annotation-pdf-page',
      kind: 'pdf',
      target: 'agent',
      source: {
        kind: 'upload-version',
        projectId: 'project-1',
        sessionId: 'session-1',
        path: 'upload-version:project-1/session-1/version-1',
        name: 'paper.pdf',
        versionId: 'version-1',
        checksum: 'a'.repeat(64)
      },
      selector: {
        kind: 'text',
        pageNumber: 7,
        exact: 'late PDF quote',
        position: { start: 0, end: 14 },
        quads: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.03 }],
        extractorVersion: 'pdfjs-5.4.624'
      }
    }

    requestAnnotationReveal(annotation)
    const listener = vi.fn()
    const unsubscribe = subscribeAnnotationRevealPreparation(listener)

    expect(listener).toHaveBeenCalledWith(annotation)
    unsubscribe()
    subscribeAnnotationReveal(() => true)()
  })

  it('keeps a pending reveal claimable after the visual highlight duration has elapsed', () => {
    requestAnnotationReveal(agentAnnotation('annotation-late-after-duration'))

    vi.advanceTimersByTime(1_601)
    const listener = vi.fn(() => true)
    const unsubscribe = subscribeAnnotationReveal(listener)

    expect(listener).toHaveBeenCalledWith('annotation-late-after-duration')
    unsubscribe()
  })

  it('lets a newer pending reveal supersede an unclaimed request', () => {
    requestAnnotationReveal(agentAnnotation('annotation-stale'))
    requestAnnotationReveal(agentAnnotation('annotation-current'))

    const listener = vi.fn(() => true)
    const unsubscribe = subscribeAnnotationReveal(listener)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('annotation-current')
    unsubscribe()
  })

  it('switches to an existing immutable source file tab without replacing its metadata', () => {
    const existing: PreviewFileItem = {
      id: 'artifact-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      title: 'figure.png',
      type: 'file',
      path: 'artifact-version:project-1/session-1/artifact-1/version-1',
      name: 'figure.png',
      format: 'image',
      mimeType: 'image/png',
      size: 123,
      artifactId: 'artifact-1',
      selectedVersionId: 'version-1'
    }
    usePreviewWorkbenchStore.getState().upsertItem(existing)
    const annotation: Annotation = {
      id: 'point-1',
      kind: 'image-point',
      target: 'agent',
      note: 'Inspect this point',
      source: {
        kind: 'artifact-version',
        projectId: 'project-1',
        sessionId: 'session-1',
        versionId: 'version-1',
        name: 'figure.png',
        path: existing.path,
        mimeType: 'image/png'
      },
      point: { x: 0.4, y: 0.6 },
      naturalSize: { width: 800, height: 600 }
    }

    requestAnnotationReveal(annotation)

    const state = usePreviewWorkbenchStore.getState()
    expect(state.activeItemId).toBe('artifact-1')
    expect(state.panelState).toBe('open')
    expect(state.items[0]).toMatchObject({ size: 123, selectedVersionId: 'version-1' })
  })

  it('opens a missing source file tab from the annotation version identity', () => {
    const sourcePath = 'artifact-version:project-1/session-1/artifact-9/version-3'
    const annotation: Annotation = {
      id: 'file-quote-1',
      kind: 'text',
      target: 'agent',
      quote: 'Important result',
      source: {
        kind: 'project-file',
        projectId: 'project-1',
        sessionId: 'session-1',
        path: sourcePath,
        name: 'results.md',
        versionId: 'version-3'
      }
    }

    requestAnnotationReveal(annotation)

    expect(usePreviewWorkbenchStore.getState()).toMatchObject({
      activeItemId: 'artifact-9',
      panelState: 'open',
      items: [
        expect.objectContaining({
          id: 'artifact-9',
          projectId: 'project-1',
          sessionId: 'session-1',
          path: sourcePath,
          name: 'results.md',
          format: 'markdown',
          artifactId: 'artifact-9',
          selectedVersionId: 'version-3'
        })
      ]
    })
  })
})
