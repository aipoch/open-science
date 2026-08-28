// @vitest-environment jsdom
import { act, type ComponentProps, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'react-zoom-pan-pinch'

import { createArtifactVersionLocator } from '../../../../../shared/artifact-provenance'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { ImagePointAnnotationSurface } from './ImagePointAnnotationSurface'
import { requestAnnotationReveal } from './annotation-reveal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const item: PreviewFileItem = {
  id: 'artifact-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  title: 'figure.png',
  type: 'file',
  path: createArtifactVersionLocator({
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactId: 'artifact-1',
    versionId: 'version-1'
  }),
  format: 'image',
  name: 'figure.png',
  mimeType: 'image/png',
  artifactId: 'artifact-1',
  selectedVersionId: 'version-1'
}

describe('ImagePointAnnotationSurface', () => {
  let container: HTMLDivElement
  let root: Root
  let onAdd: NonNullable<ComponentProps<typeof ImagePointAnnotationSurface>['onAdd']>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    onAdd = vi.fn()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const renderSurface = async (
    props: Partial<ComponentProps<typeof ImagePointAnnotationSurface>> = {},
    loadImage = true,
    wrap: (surface: ReactElement) => ReactElement = (surface) => surface
  ): Promise<HTMLImageElement> => {
    await act(async () => {
      root.render(
        wrap(
          <ImagePointAnnotationSurface
            item={item}
            src="blob:figure"
            activeAnnotations={[]}
            onAdd={onAdd}
            onAnnotationError={vi.fn()}
            onImageError={vi.fn()}
            {...props}
          />
        )
      )
    })
    const surface = container.querySelector<HTMLElement>('[data-image-annotation-surface]')!
    const image = container.querySelector<HTMLImageElement>('img')!
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 800 },
      naturalHeight: { configurable: true, value: 400 }
    })
    surface.getBoundingClientRect = () =>
      ({ left: 10, top: 20, right: 410, bottom: 420, width: 400, height: 400 }) as DOMRect
    Object.defineProperties(surface, {
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 400 }
    })
    if (loadImage) {
      await act(async () => image.dispatchEvent(new Event('load', { bubbles: true })))
    }
    return image
  }

  const pointer = async (
    target: Element,
    type: 'pointerdown' | 'pointerup',
    clientX: number,
    clientY: number,
    button = 0
  ): Promise<void> => {
    await act(async () => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, button, clientX, clientY }))
    })
  }

  it('creates a temporary numbered point only for a short left click in real image pixels', async () => {
    const image = await renderSurface()

    // The 2:1 image is vertically letterboxed inside the square surface (real pixels y=120..320).
    await pointer(image, 'pointerdown', 210, 80)
    await pointer(image, 'pointerup', 210, 80)
    expect(document.body.textContent).not.toContain('Image point 1')

    await pointer(image, 'pointerdown', 210, 220)
    await pointer(image, 'pointerup', 213, 222)
    expect(document.body.textContent).toContain('Image point 1')
    expect(document.querySelector('textarea')?.getAttribute('aria-label')).toBe('Annotation note')
  })

  it('renders the annotation editor above full-screen preview chrome', async () => {
    const image = await renderSurface()

    await pointer(image, 'pointerdown', 210, 220)
    await pointer(image, 'pointerup', 210, 220)

    const popover = document.querySelector<HTMLElement>(
      '[data-radix-popper-content-wrapper] > [data-state="open"]'
    )
    expect(popover).not.toBeNull()
    expect(popover?.className).toContain('z-[70]')
    expect(popover?.className).not.toContain('z-50')
  })

  it('discards a temporary point on cancel and never adds it to the draft', async () => {
    const image = await renderSurface()
    await pointer(image, 'pointerdown', 210, 220)
    await pointer(image, 'pointerup', 210, 220)

    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Cancel')
        ?.click()
    })

    expect(onAdd).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Image point 1')
    expect(document.activeElement).toBe(
      container.querySelector<HTMLElement>('[data-image-annotation-surface]')
    )
  })

  it('requires a note and saves normalized coordinates with natural dimensions and fixed Version', async () => {
    const image = await renderSurface()
    await pointer(image, 'pointerdown', 210, 220)
    await pointer(image, 'pointerup', 210, 220)

    const annotate = (): HTMLButtonElement | undefined =>
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Annotate'
      )
    await act(async () => annotate()?.click())
    expect(document.body.textContent).toContain('Add a note for this image annotation')
    expect(onAdd).not.toHaveBeenCalled()

    const note = document.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(note, 'Inspect this peak.')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => annotate()?.click())

    expect(onAdd).toHaveBeenCalledWith({
      id: expect.stringMatching(/^annotation-/),
      kind: 'image-point',
      target: 'agent',
      note: 'Inspect this peak.',
      source: expect.objectContaining({
        kind: 'artifact-version',
        versionId: 'version-1',
        path: expect.stringMatching(/^artifact-version:/)
      }),
      point: { x: 0.5, y: 0.5 },
      naturalSize: { width: 800, height: 400 }
    })
  })

  it('does not create a point when pointer movement exceeds the click threshold', async () => {
    const image = await renderSurface()
    await pointer(image, 'pointerdown', 100, 200)
    await pointer(image, 'pointerup', 125, 220)

    expect(document.body.textContent).not.toContain('Image point 1')
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('ignores clicks before load, unsupported formats, and non-left buttons', async () => {
    const unloaded = await renderSurface({}, false)
    await pointer(unloaded, 'pointerdown', 210, 220)
    await pointer(unloaded, 'pointerup', 210, 220)
    expect(document.body.textContent).not.toContain('Image point 1')

    await act(async () => unloaded.dispatchEvent(new Event('load', { bubbles: true })))
    await pointer(unloaded, 'pointerdown', 210, 220, 2)
    await pointer(unloaded, 'pointerup', 210, 220, 2)
    expect(document.body.textContent).not.toContain('Image point 1')

    await renderSurface({ item: { ...item, name: 'figure.gif', mimeType: 'image/gif' } })
    const unsupported = container.querySelector('img')!
    await pointer(unsupported, 'pointerdown', 210, 220)
    await pointer(unsupported, 'pointerup', 210, 220)
    expect(document.body.textContent).not.toContain('Image point 1')
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('previews an existing marker before Edit and uses Cancel/Save only in edit mode', async () => {
    const onUpdateNote = vi.fn()
    const onRemove = vi.fn()
    await renderSurface({
      activeAnnotations: [
        {
          id: 'point-existing',
          kind: 'image-point',
          target: 'agent',
          note: 'Original note',
          source: {
            kind: 'artifact-version',
            projectId: 'project-1',
            sessionId: 'session-1',
            versionId: 'version-1',
            name: 'figure.png',
            path: item.path,
            mimeType: 'image/png'
          },
          point: { x: 0.5, y: 0.5 },
          naturalSize: { width: 800, height: 400 }
        }
      ],
      onUpdateNote,
      onRemove
    })

    const marker = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '1'
    )!
    expect(marker.className).toContain('focus-visible:ring-[3px]')
    expect(marker.className).toContain('focus-visible:ring-ring/50')
    await act(async () => marker.click())
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.querySelector('[data-image-annotation-preview]')?.textContent).toBe(
      'Original note'
    )
    expect(document.body.textContent).toContain('Edit')
    expect(document.body.textContent).toContain('Delete')
    await act(async () =>
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Edit')
        ?.click()
    )
    const note = document.querySelector('textarea')!
    expect(note.value).toBe('Original note')
    await act(async () =>
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Cancel')
        ?.click()
    )
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.querySelector('[data-image-annotation-preview]')).not.toBeNull()

    await act(async () =>
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Edit')
        ?.click()
    )
    const reopenedNote = document.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(reopenedNote, 'Updated note')
      reopenedNote.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Save')
        ?.click()
    )
    expect(onUpdateNote).toHaveBeenCalledWith('point-existing', 'Updated note')

    await act(async () => marker.click())
    await act(async () =>
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Delete')
        ?.click()
    )
    expect(onRemove).toHaveBeenCalledWith('point-existing')
  })

  it('opens an existing pin preview when the composer reveals its source', async () => {
    const annotation = {
      id: 'point-reveal',
      kind: 'image-point',
      target: 'agent',
      note: 'Revealed from composer',
      source: {
        kind: 'artifact-version',
        projectId: 'project-1',
        sessionId: 'session-1',
        versionId: 'version-1',
        name: 'figure.png',
        path: item.path,
        mimeType: 'image/png'
      },
      point: { x: 0.5, y: 0.5 },
      naturalSize: { width: 800, height: 400 }
    } as const
    await renderSurface({
      activeAnnotations: [annotation]
    })

    await act(async () => requestAnnotationReveal(annotation))
    expect(document.querySelector('[data-image-annotation-preview]')?.textContent).toBe(
      'Revealed from composer'
    )
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('repositions normalized markers after the surface is resized', async () => {
    let notifyResize: (() => void) | undefined
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notifyResize = callback
        }
        observe(): void {
          return undefined
        }
        disconnect(): void {
          return undefined
        }
      }
    )
    await renderSurface({
      activeAnnotations: [
        {
          id: 'point-resize',
          kind: 'image-point',
          target: 'agent',
          note: 'Track this pixel',
          source: {
            kind: 'artifact-version',
            projectId: 'project-1',
            sessionId: 'session-1',
            versionId: 'version-1',
            name: 'figure.png',
            path: item.path,
            mimeType: 'image/png'
          },
          point: { x: 0.5, y: 0.5 },
          naturalSize: { width: 800, height: 400 }
        }
      ]
    })
    const surface = container.querySelector<HTMLElement>('[data-image-annotation-surface]')!
    const marker = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === '1'
    )!
    expect(marker.style.left).toBe('200px')
    expect(marker.style.top).toBe('200px')

    Object.defineProperties(surface, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 400 }
    })
    await act(async () => notifyResize?.())

    expect(marker.style.left).toBe('400px')
    expect(marker.style.top).toBe('200px')
  })

  it('renders unscaled markers outside a zoom wrapper', async () => {
    await renderSurface({
      activeAnnotations: [
        {
          id: 'point-plain',
          kind: 'image-point',
          target: 'agent',
          note: 'Unzoomed point',
          source: {
            kind: 'artifact-version',
            projectId: 'project-1',
            sessionId: 'session-1',
            versionId: 'version-1',
            name: 'figure.png',
            path: item.path,
            mimeType: 'image/png'
          },
          point: { x: 0.5, y: 0.5 },
          naturalSize: { width: 800, height: 400 }
        }
      ]
    })
    const marker = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === '1'
    )!
    expect(marker.style.transform).toBe('translate(-50%, -50%) scale(1)')
  })

  it('keeps markers and the pending ring at a constant on-screen size while zoomed', async () => {
    type ZoomInstance = React.ContextType<typeof Context>
    const listeners: Array<() => void> = []
    const zoom = {
      state: { scale: 2 },
      onChange: (callback: () => void) => {
        listeners.push(callback)
        return () => undefined
      }
    } as unknown as ZoomInstance
    const image = await renderSurface(
      {
        activeAnnotations: [
          {
            id: 'point-zoomed',
            kind: 'image-point',
            target: 'agent',
            note: 'Zoomed point',
            source: {
              kind: 'artifact-version',
              projectId: 'project-1',
              sessionId: 'session-1',
              versionId: 'version-1',
              name: 'figure.png',
              path: item.path,
              mimeType: 'image/png'
            },
            point: { x: 0.5, y: 0.5 },
            naturalSize: { width: 800, height: 400 }
          }
        ]
      },
      true,
      (surface) => <Context.Provider value={zoom}>{surface}</Context.Provider>
    )
    const marker = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === '1'
    )!
    // The zoom wrapper scales the whole surface by 2; the marker counters
    // with scale(1/2) so its on-screen size stays constant.
    expect(marker.style.transform).toBe('translate(-50%, -50%) scale(0.5)')

    await pointer(image, 'pointerdown', 210, 220)
    await pointer(image, 'pointerup', 210, 220)
    const ring = container.querySelector<HTMLElement>('span[aria-hidden="true"]')
    expect(ring?.style.transform).toBe('translate(-50%, -50%) scale(0.5)')

    await act(async () => {
      zoom.state.scale = 4
      for (const listener of listeners) listener()
    })
    expect(marker.style.transform).toBe('translate(-50%, -50%) scale(0.25)')
  })
})
