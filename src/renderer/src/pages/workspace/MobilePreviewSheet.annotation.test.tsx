// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Annotation } from '../../../../shared/annotations'

vi.mock('./PreviewPanel', () => ({
  PreviewPanelSurface: ({
    activeAnnotations,
    onAddAnnotation
  }: {
    activeAnnotations?: readonly Annotation[]
    onAddAnnotation?: (annotation: Annotation) => void
  }) => (
    <button
      type="button"
      data-testid="mobile-preview-annotation-port"
      data-count={activeAnnotations?.length ?? 0}
      onClick={() => activeAnnotations?.[0] && onAddAnnotation?.(activeAnnotations[0])}
    >
      preview
    </button>
  )
}))

const { MobilePreviewSheet } = await import('./MobilePreviewSheet')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('MobilePreviewSheet annotation port', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('forwards the same active draft and actions to the mobile preview surface', async () => {
    const annotation: Annotation = {
      id: 'annotation-mobile',
      kind: 'text',
      target: 'agent',
      quote: 'Mobile evidence',
      source: { kind: 'agent-message', sessionId: 'session-1', messageId: 'message-1' }
    }
    const onAddAnnotation = vi.fn()
    await act(async () => {
      root.render(
        <MobilePreviewSheet
          open
          onClose={vi.fn()}
          activeAnnotations={[annotation]}
          onAddAnnotation={onAddAnnotation}
        />
      )
    })

    const port = document.querySelector<HTMLButtonElement>(
      '[data-testid="mobile-preview-annotation-port"]'
    )!
    expect(port.dataset.count).toBe('1')
    await act(async () => port.click())
    expect(onAddAnnotation).toHaveBeenCalledWith(annotation)
  })
})
