// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ActionMenuProvider, ActionMenuTarget } from '@/components/action-menu'

import { PreviewActionMenuAdapterProvider } from './preview-action-adapter'
import { useRegisterPreviewContextMenuFrame } from './preview-action-hooks'
import {
  PREVIEW_CAPABILITY_CATALOG,
  type PreviewActionBindings,
  type PreviewCapabilityId
} from './preview-action-model'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let emitFrameContextMenu:
  ((request: { x: number; y: number; frameUrl: string }) => void) | undefined
const unsubscribeFrameContextMenu = vi.fn()
const subscribeFrameContextMenu = vi.fn(
  (listener: NonNullable<typeof emitFrameContextMenu>): (() => void) => {
    emitFrameContextMenu = listener
    return unsubscribeFrameContextMenu
  }
)

beforeEach(() => {
  emitFrameContextMenu = undefined
  unsubscribeFrameContextMenu.mockClear()
  subscribeFrameContextMenu.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      previewContextMenu: {
        onRequested: subscribeFrameContextMenu
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

const FrameRegistration = ({ frameUrl }: { frameUrl: string }): React.JSX.Element => {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  useRegisterPreviewContextMenuFrame({ id: 'rendered-preview', frameUrl, frameRef })
  return <iframe ref={frameRef} src={frameUrl} title="Rendered preview" />
}

const bindings: PreviewActionBindings = {
  'copy-path': { execute: () => undefined }
}

const FrameHarness = ({
  frameUrl,
  actionBindings = bindings
}: {
  frameUrl: string
  actionBindings?: PreviewActionBindings
}): React.JSX.Element => (
  <ActionMenuProvider testId="preview-content-context-menu">
    <PreviewActionMenuAdapterProvider targetId="preview-content">
      <ActionMenuTarget<PreviewCapabilityId, undefined>
        targetId="preview-content"
        identityKey={frameUrl}
        catalog={PREVIEW_CAPABILITY_CATALOG}
        recipe={[{ kind: 'action', action: 'copy-path' }]}
        bindings={actionBindings}
        invocation={undefined}
        asChild
      >
        <div>
          <FrameRegistration frameUrl={frameUrl} />
        </div>
      </ActionMenuTarget>
    </PreviewActionMenuAdapterProvider>
  </ActionMenuProvider>
)

const render = async (frameUrl: string, actionBindings?: PreviewActionBindings): Promise<void> => {
  await act(async () => {
    root.render(<FrameHarness frameUrl={frameUrl} actionBindings={actionBindings} />)
    await Promise.resolve()
  })
}

describe('Preview Action Menu adapter', () => {
  it('keeps the Electron subscription and frame registration stable across pending changes', async () => {
    let settle: (() => void) | undefined
    const frameUrl = 'open-science-preview://resource-1/report.html'
    await render(frameUrl, {
      'copy-path': {
        execute: () => new Promise<void>((resolve) => (settle = resolve))
      }
    })
    expect(subscribeFrameContextMenu).toHaveBeenCalledOnce()

    await act(async () => {
      emitFrameContextMenu?.({ x: 31, y: 47, frameUrl })
      await Promise.resolve()
    })
    await act(async () => {
      document.body.querySelector<HTMLElement>('[data-action-id="copy-path"]')!.click()
      await Promise.resolve()
    })

    expect(settle).toBeTypeOf('function')
    expect(subscribeFrameContextMenu).toHaveBeenCalledOnce()
    expect(unsubscribeFrameContextMenu).not.toHaveBeenCalled()

    await act(async () => {
      emitFrameContextMenu?.({ x: 41, y: 53, frameUrl })
      await Promise.resolve()
    })
    expect(
      document.body.querySelector('[data-action-id="copy-path"]')?.hasAttribute('data-disabled')
    ).toBe(true)

    if (!settle) throw new Error('Expected the deferred preview action to start')
    const settleAction = settle
    await act(async () => {
      settleAction()
      await Promise.resolve()
    })
    expect(subscribeFrameContextMenu).toHaveBeenCalledOnce()
    expect(unsubscribeFrameContextMenu).not.toHaveBeenCalled()
    expect(
      document.body.querySelector('[data-action-id="copy-path"]')?.hasAttribute('data-disabled')
    ).toBe(false)
  })

  it('opens for the registered frame at Electron viewport coordinates and restores iframe focus', async () => {
    const frameUrl = 'open-science-preview://resource-1/report.html'
    await render(frameUrl)
    const frame = container.querySelector('iframe')!
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
      x: 120,
      y: 80,
      left: 120,
      top: 80,
      right: 620,
      bottom: 480,
      width: 500,
      height: 400,
      toJSON: () => undefined
    })

    await act(async () => {
      emitFrameContextMenu?.({ x: 31, y: 47, frameUrl })
      await Promise.resolve()
    })

    const anchor = document.body.querySelector<HTMLElement>(
      '[data-testid="preview-content-context-menu-anchor"]'
    )
    expect(anchor?.style.cssText).toContain('left: 31px; top: 47px')
    await act(async () => {
      document.body.querySelector<HTMLElement>('[data-action-id="copy-path"]')!.click()
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(frame)
  })

  it('matches managed HTML by resource hostname while keeping Office session URLs strict', async () => {
    const frameUrl = 'open-science-preview://resource-1/report.html'
    await render(frameUrl)

    await act(async () => {
      emitFrameContextMenu?.({
        x: 41,
        y: 53,
        frameUrl: `${frameUrl}#results`
      })
      await Promise.resolve()
    })
    expect(document.body.querySelector('[data-action-id="copy-path"]')).not.toBeNull()

    const officeUrl =
      'open-science-office-preview://runtime/office-preview.html?sessionId=session-1'
    await render(officeUrl)
    await act(async () => {
      emitFrameContextMenu?.({
        x: 5,
        y: 7,
        frameUrl: `${officeUrl}#results`
      })
      await Promise.resolve()
    })
    expect(document.body.querySelector('[data-action-id="copy-path"]')).toBeNull()
  })

  it('ignores stale and unknown frame URLs after registration changes', async () => {
    const oldUrl = 'open-science-preview://resource-1/report.html'
    const newUrl = 'open-science-preview://resource-2/report.html'
    await render(oldUrl)
    await render(newUrl)

    await act(async () => {
      emitFrameContextMenu?.({ x: 1, y: 2, frameUrl: oldUrl })
      await Promise.resolve()
    })
    expect(document.body.querySelector('[data-action-id="copy-path"]')).toBeNull()

    await act(async () => {
      emitFrameContextMenu?.({ x: 3, y: 4, frameUrl: newUrl })
      await Promise.resolve()
    })
    expect(document.body.querySelector('[data-action-id="copy-path"]')).not.toBeNull()
  })
})
