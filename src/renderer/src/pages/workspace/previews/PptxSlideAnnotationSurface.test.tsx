// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { PptSlideAnnotation } from '../../../../../shared/annotation-contract'
import { createArtifactVersionLocator } from '../../../../../shared/artifact-provenance'
import type { DeckOutline } from '../../../../../shared/pptx-edit'
import {
  requestAnnotationReveal,
  subscribeAnnotationReveal
} from '../annotations/annotation-reveal'
import { PptxSlideAnnotationSurface } from './PptxSlideAnnotationSurface'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

vi.mock('./renderers/OfficePreview', () => ({
  OfficePreviewContent: ({
    onSlideView,
    slideRequest
  }: {
    onSlideView?: (view: unknown) => void
    slideRequest?: unknown
  }) => (
    <button
      data-request={JSON.stringify(slideRequest ?? null)}
      type="button"
      data-testid="office-preview"
      onClick={() =>
        onSlideView?.({ sessionId: 's', slideIndex: 0, x: 0, y: 0, width: 914.4, height: 514.35 })
      }
    />
  )
}))

const outline = {
  slideSize: { cx: 9_144_000, cy: 5_143_500 },
  layouts: [],
  slides: [
    {
      slideId: 256,
      index: 0,
      part: 'ppt/slides/slide1.xml',
      notes: '',
      shapes: [
        {
          shapeId: 2,
          name: 'Title',
          kind: 'text',
          frame: { x: 914_400, y: 457_200, w: 1_828_800, h: 914_400, rotationDeg: 0 }
        }
      ]
    }
  ]
} as unknown as DeckOutline

vi.mock('./use-pptx-outline', () => ({ usePptxOutline: () => outline }))

beforeAll(() => {
  HTMLElement.prototype.setPointerCapture = vi.fn()
})
afterEach(() => {
  cleanup()
  subscribeAnnotationReveal(() => true)()
})

const item = {
  id: 'artifact-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  title: 'deck.pptx',
  type: 'file',
  path: createArtifactVersionLocator({
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactId: 'artifact-1',
    versionId: 'version-1'
  }),
  format: 'presentation',
  name: 'deck.pptx',
  managedFileId: 'file-1',
  artifactId: 'artifact-1',
  selectedVersionId: 'version-1'
} as PreviewFileItem

const renderSurface = (disabled = false): ReturnType<typeof vi.fn> => {
  const onAdd = vi.fn(() => undefined)
  render(
    <PptxSlideAnnotationSurface
      item={item}
      activeAnnotations={[]}
      disabled={disabled}
      onAdd={onAdd}
    />
  )
  fireEvent.click(screen.getByTestId('office-preview'))
  return onAdd
}

const sentAnnotation = (versionId: string): PptSlideAnnotation => ({
  id: 'sent-1',
  kind: 'pptx-slide',
  target: 'agent',
  note: 'Shorten the title',
  source: {
    kind: 'artifact-version',
    projectId: 'project-1',
    sessionId: 'session-1',
    versionId,
    name: 'deck.pptx',
    path: item.path
  },
  slideId: 256,
  slideIndex: 0,
  shapeId: 2
})

describe('PptxSlideAnnotationSurface', () => {
  it('adds a shape annotation after a note is entered', () => {
    const onAdd = renderSurface()
    fireEvent.click(screen.getByRole('button', { name: 'Annotate slide' }))
    const layer = screen.getByTestId('pptx-slide-annotation-layer')
    fireEvent.pointerDown(layer, { clientX: 100, clientY: 60, button: 0, pointerId: 1 })
    fireEvent.pointerUp(layer, { clientX: 100, clientY: 60, pointerId: 1 })
    fireEvent.change(screen.getByLabelText('Annotation note'), {
      target: { value: '  Shorten the title  ' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add annotation' }))
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'pptx-slide',
        note: 'Shorten the title',
        slideId: 256,
        slideIndex: 0,
        shapeId: 2,
        source: expect.objectContaining({ kind: 'artifact-version', versionId: 'version-1' })
      })
    )
    expect(screen.queryByTestId('pptx-slide-note-editor')).toBeNull()
  })

  it('offers no annotate control while disabled', () => {
    renderSurface(true)
    expect(screen.queryByRole('button', { name: 'Annotate slide' })).toBeNull()
  })

  it('jumps to a revealed sent annotation and marks it even while disabled', () => {
    renderSurface(true)
    act(() => requestAnnotationReveal(sentAnnotation('version-1')))
    expect(JSON.parse(screen.getByTestId('office-preview').dataset.request ?? 'null')).toEqual({
      slideIndex: 0,
      serial: 1
    })
    const marker = document.querySelector('[data-annotation-marker="sent-1"]')
    expect(marker?.hasAttribute('data-revealed')).toBe(true)
  })

  it('ignores reveals for another deck version', () => {
    renderSurface()
    act(() => requestAnnotationReveal(sentAnnotation('version-2')))
    expect(screen.getByTestId('office-preview').dataset.request).toBe('null')
    expect(document.querySelector('[data-annotation-marker]')).toBeNull()
  })
})
