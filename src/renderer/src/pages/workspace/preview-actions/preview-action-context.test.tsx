// @vitest-environment jsdom
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PreviewActionContext,
  usePreviewActionHost,
  useRegisterPreviewContextMenuFrame
} from './preview-action-context'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let emitFrameContextMenu:
  ((request: { x: number; y: number; frameUrl: string }) => void) | undefined
const unsubscribeFrameContextMenu = vi.fn()

beforeEach(() => {
  emitFrameContextMenu = undefined
  unsubscribeFrameContextMenu.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      previewContextMenu: {
        onRequested: (listener: typeof emitFrameContextMenu) => {
          emitFrameContextMenu = listener
          return unsubscribeFrameContextMenu
        }
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

const ExecuteHarness = ({ value }: { value: string }): React.JSX.Element => {
  const [executedValue, setExecutedValue] = useState('')
  const host = usePreviewActionHost({
    identityKey: 'file-1:version-1',
    recipe: [{ kind: 'action', capability: 'copy-path' }],
    bindings: { 'copy-path': { execute: () => setExecutedValue(value) } }
  })

  return (
    <>
      <button type="button" onClick={() => host.execute('copy-path')}>
        Run
      </button>
      <output>{executedValue}</output>
    </>
  )
}

const AsyncHarness = ({ execute }: { execute: () => Promise<void> }): React.JSX.Element => {
  const host = usePreviewActionHost({
    identityKey: 'file-1:version-1',
    recipe: [{ kind: 'action', capability: 'download' }],
    bindings: { download: { execute } }
  })
  const action = host.entries.find((entry) => entry.kind === 'action')

  return (
    <>
      <button type="button" onClick={() => host.execute('download')}>
        Run
      </button>
      <output>{action?.kind === 'action' && action.disabled ? 'disabled' : 'enabled'}</output>
    </>
  )
}

const ContextMenuHarness = ({ identityKey }: { identityKey: string }): React.JSX.Element => {
  const host = usePreviewActionHost({
    identityKey,
    recipe: [{ kind: 'action', capability: 'copy-path' }],
    bindings: { 'copy-path': { execute: (): void => undefined } }
  })

  return (
    <>
      <button
        type="button"
        onClick={() => host.openContextMenu({ x: 12, y: 24 }, document.activeElement)}
      >
        Open
      </button>
      <output>
        {host.contextMenu
          ? `${host.contextMenu.pointer.x}:${host.contextMenu.pointer.y}`
          : 'closed'}
      </output>
    </>
  )
}

const FrameRegistration = ({ frameUrl }: { frameUrl: string }): React.JSX.Element => {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  useRegisterPreviewContextMenuFrame({ id: 'rendered-preview', frameUrl, frameRef })
  return <iframe ref={frameRef} src={frameUrl} title="Rendered preview" />
}

const FrameContextMenuHarness = ({ frameUrl }: { frameUrl: string }): React.JSX.Element => {
  const host = usePreviewActionHost({
    identityKey: frameUrl,
    recipe: [{ kind: 'action', capability: 'copy-path' }],
    bindings: { 'copy-path': { execute: (): void => undefined } }
  })

  return (
    <PreviewActionContext.Provider value={host}>
      <FrameRegistration frameUrl={frameUrl} />
      <button type="button" onClick={host.restoreContextMenuFocus}>
        Restore focus
      </button>
      <output>
        {host.contextMenu
          ? `${host.contextMenu.pointer.x}:${host.contextMenu.pointer.y}`
          : 'closed'}
      </output>
    </PreviewActionContext.Provider>
  )
}

describe('preview action context', () => {
  it('executes the latest binding after the host rerenders', async () => {
    act(() => root.render(<ExecuteHarness value="first" />))
    act(() => root.render(<ExecuteHarness value="second" />))

    await act(async () => container.querySelector('button')?.click())

    expect(container.querySelector('output')?.textContent).toBe('second')
  })

  it('disables an asynchronous action until its execution settles', async () => {
    let resolveOperation = (): void => undefined
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve
    })
    const execute = vi.fn(() => operation)
    act(() => root.render(<AsyncHarness execute={execute} />))

    await act(async () => container.querySelector('button')?.click())
    expect(container.querySelector('output')?.textContent).toBe('disabled')
    await act(async () => container.querySelector('button')?.click())
    expect(execute).toHaveBeenCalledOnce()

    await act(async () => {
      resolveOperation()
      await operation
    })
    expect(container.querySelector('output')?.textContent).toBe('enabled')
  })

  it('recovers from a rejected action and identifies the failed capability', async () => {
    let rejectOperation: (error: Error) => void = vi.fn()
    const operation = new Promise<void>((_resolve, reject) => {
      rejectOperation = reject
    })
    const error = new Error('save failed')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    act(() => root.render(<AsyncHarness execute={() => operation} />))

    await act(async () => container.querySelector('button')?.click())
    await act(async () => {
      rejectOperation(error)
      await operation.catch(() => undefined)
      await Promise.resolve()
    })

    expect(container.querySelector('output')?.textContent).toBe('enabled')
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to execute preview capability download for file-1:version-1',
      error
    )
    errorSpy.mockRestore()
  })

  it('closes an open context menu when the preview identity changes', async () => {
    act(() => root.render(<ContextMenuHarness identityKey="file-1:version-1" />))
    await act(async () => container.querySelector('button')?.click())
    expect(container.querySelector('output')?.textContent).toBe('12:24')

    await act(async () => {
      root.render(<ContextMenuHarness identityKey="file-1:version-2" />)
      await Promise.resolve()
    })
    expect(container.querySelector('output')?.textContent).toBe('closed')

    await act(async () => {
      root.render(<ContextMenuHarness identityKey="file-1:version-1" />)
      await Promise.resolve()
    })
    expect(container.querySelector('output')?.textContent).toBe('closed')
  })

  it('opens for the currently registered preview frame and restores focus to its iframe', async () => {
    const frameUrl = 'open-science-preview://resource-1/report.html'
    await act(async () => {
      root.render(<FrameContextMenuHarness frameUrl={frameUrl} />)
      await Promise.resolve()
    })
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
      emitFrameContextMenu?.({
        x: 31,
        y: 47,
        frameUrl
      })
    })

    expect(container.querySelector('output')?.textContent).toBe('31:47')
    await act(async () => container.querySelector('button')?.click())
    expect(document.activeElement).toBe(frame)
  })

  it('matches managed HTML by resource hostname while keeping Office session URLs strict', async () => {
    const frameUrl = 'open-science-preview://resource-1/report.html'
    await act(async () => {
      root.render(<FrameContextMenuHarness frameUrl={frameUrl} />)
      await Promise.resolve()
    })

    await act(async () => {
      emitFrameContextMenu?.({
        x: 1,
        y: 2,
        frameUrl: 'open-science-preview://resource-2/report.html#results'
      })
    })
    expect(container.querySelector('output')?.textContent).toBe('closed')

    await act(async () => {
      emitFrameContextMenu?.({
        x: 41,
        y: 53,
        frameUrl: `${frameUrl}#results`
      })
    })

    expect(container.querySelector('output')?.textContent).toBe('41:53')

    const officeUrl =
      'open-science-office-preview://runtime/office-preview.html?sessionId=session-1'
    await act(async () => {
      root.render(<FrameContextMenuHarness frameUrl={officeUrl} />)
      await Promise.resolve()
    })
    await act(async () => {
      emitFrameContextMenu?.({
        x: 5,
        y: 7,
        frameUrl: `${officeUrl}#results`
      })
    })
    expect(container.querySelector('output')?.textContent).toBe('closed')
  })

  it('ignores stale and unknown frame URLs after registration changes', async () => {
    const oldUrl = 'open-science-preview://resource-1/report.html'
    const newUrl = 'open-science-preview://resource-2/report.html'
    await act(async () => {
      root.render(<FrameContextMenuHarness frameUrl={oldUrl} />)
      await Promise.resolve()
    })
    await act(async () => {
      root.render(<FrameContextMenuHarness frameUrl={newUrl} />)
      await Promise.resolve()
    })

    await act(async () => {
      emitFrameContextMenu?.({
        x: 1,
        y: 2,
        frameUrl: oldUrl
      })
    })
    expect(container.querySelector('output')?.textContent).toBe('closed')

    await act(async () => {
      emitFrameContextMenu?.({
        x: 3,
        y: 4,
        frameUrl: newUrl
      })
    })
    expect(container.querySelector('output')?.textContent).toBe('3:4')
  })
})
