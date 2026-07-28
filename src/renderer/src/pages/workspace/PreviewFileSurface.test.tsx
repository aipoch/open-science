// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  type PreviewFileItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import {
  createInitialSessionState,
  type ChatSession,
  useSessionStore
} from '@/stores/session-store'

const provenancePanelSpy = vi.hoisted(() => vi.fn())
const previewContentSpy = vi.hoisted(() => vi.fn())

vi.mock('./ArtifactProvenancePanel', () => ({
  ArtifactProvenancePanel: (props: { onClose: () => void }) => {
    provenancePanelSpy(props)
    return (
      <div data-testid="provenance-panel">
        <button type="button" onClick={props.onClose}>
          Close Provenance
        </button>
      </div>
    )
  }
}))

vi.mock('./ManagedFileDownloadButton', () => ({
  ManagedFileDownloadButton: () => <button type="button">Download file</button>
}))

vi.mock('./previews/PreviewFileContent', () => ({
  PreviewFileContent: (props: { item: PreviewFileItem }) => {
    previewContentSpy(props)
    return (
      <div data-testid="preview-content" data-path={props.item.path}>
        Preview content
      </div>
    )
  }
}))

import { PreviewFileSurface } from './PreviewFileSurface'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {})
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => {}
  Element.prototype.releasePointerCapture = (): void => {}
}
if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {
      /* no-op shim for Radix layout measurement in jsdom */
    }
    unobserve(): void {
      /* no-op */
    }
    disconnect(): void {
      /* no-op */
    }
  }
}

const item: PreviewFileItem = {
  id: 'artifact-1',
  artifactId: 'artifact-1',
  selectedVersionId: 'version-1',
  sessionId: 'session-1',
  type: 'file',
  title: 'sin.png',
  name: 'sin.png',
  path: '/data/sin.png',
  format: 'image',
  source: 'artifact'
}

const descriptor = {
  id: 'version-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  versionNumber: 1,
  checksum: 'checksum-1',
  createdAt: '2026-07-27T20:00:00.000Z',
  state: 'finalized' as const,
  projectName: 'project-1',
  sessionId: 'session-1',
  runId: 'artifact-run-1',
  name: 'sin.png',
  size: 12,
  mtimeMs: 1
}

const secondDescriptor = {
  ...descriptor,
  id: 'version-2',
  versionId: 'version-2',
  versionNumber: 2,
  checksum: 'checksum-2',
  size: 18,
  mtimeMs: 2
}

const thirdDescriptor = {
  ...descriptor,
  id: 'version-3',
  versionId: 'version-3',
  versionNumber: 3,
  checksum: 'checksum-3',
  size: 24,
  mtimeMs: 3
}

let container: HTMLDivElement
let root: Root

const click = async (element: HTMLElement | null): Promise<void> => {
  if (!element) throw new Error('element not found')
  await act(async () => element.click())
}

const openMenu = async (trigger: Element | null): Promise<void> => {
  if (!trigger) throw new Error('menu trigger not found')
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

const zIndexFromClassName = (element: Element): number => {
  const match = element.className.match(/(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?:\s|$)/)
  return Number(match?.[1] ?? match?.[2] ?? Number.NaN)
}

beforeEach(() => {
  provenancePanelSpy.mockClear()
  previewContentSpy.mockClear()
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  usePreviewWorkbenchStore.getState().activateProject('project-1')
  useSessionStore.setState(createInitialSessionState())
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      artifacts: {
        getLineage: vi.fn().mockResolvedValue({
          artifactId: 'artifact-1',
          filename: 'sin.png',
          originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
          versions: [descriptor, secondDescriptor]
        })
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

describe('PreviewFileSurface Provenance entry', () => {
  it('opens and closes Provenance from the full-screen preview header', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={item} provenanceEntry="leading" onClose={vi.fn()} />)
    })

    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    await click(container.querySelector('[aria-label="Open Provenance for sin.png"]'))

    expect(container.querySelector('[data-testid="provenance-panel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).toBeNull()
    expect(provenancePanelSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({
          id: 'artifact-1',
          selectedVersionId: 'version-1',
          versionNumber: 1
        }),
        projectId: 'project-1'
      })
    )

    await click(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Close Provenance'
      ) ?? null
    )

    expect(container.querySelector('[data-testid="provenance-panel"]')).toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
  })

  it('does not offer Provenance for uploaded inputs', async () => {
    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, id: 'upload-1', artifactId: undefined, source: 'upload' }}
          provenanceEntry="leading"
          onClose={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[aria-label^="Open Provenance"]')).toBeNull()
  })

  it('keeps Provenance open when the selected Artifact version changes', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={item} provenanceEntry="leading" onClose={vi.fn()} />)
    })
    await click(container.querySelector('[aria-label="Open Provenance for sin.png"]'))

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, selectedVersionId: 'version-2', versionNumber: 2 }}
          provenanceEntry="leading"
          onClose={vi.fn()}
        />
      )
    })

    expect(container.querySelector('[data-testid="provenance-panel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).toBeNull()
  })

  it('switches Artifact versions while keeping the image preview open', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={item} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const next = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Next Artifact version"]'
    )
    expect(next).not.toBeNull()

    await click(next)

    expect(container.querySelector('[data-testid="provenance-panel"]')).toBeNull()
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    expect(container.textContent).toContain('v2')
    expect(previewContentSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({
          id: 'artifact-1',
          selectedVersionId: 'version-2',
          versionNumber: 2,
          path: 'artifact-version:project-1/session-1/artifact-1/version-2'
        })
      })
    )
    expect(usePreviewWorkbenchStore.getState().items).toHaveLength(0)
  })

  it('refreshes a stale lineage when a GENERATED click selects a newly finalized version', async () => {
    const getLineage = vi
      .fn()
      .mockResolvedValueOnce({
        artifactId: 'artifact-1',
        filename: 'sin.png',
        originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
        versions: [descriptor, secondDescriptor]
      })
      .mockResolvedValueOnce({
        artifactId: 'artifact-1',
        filename: 'sin.png',
        originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
        versions: [descriptor, secondDescriptor, thirdDescriptor]
      })
    window.api.artifacts.getLineage = getLineage
    const versionTwoItem = {
      ...item,
      selectedVersionId: 'version-2',
      versionNumber: 2,
      path: 'artifact-version:project-1/session-1/artifact-1/version-2'
    }

    await act(async () => {
      root.render(<PreviewFileSurface item={versionTwoItem} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('v2')

    await act(async () => {
      usePreviewWorkbenchStore.getState().upsertAndActivateItem({
        ...versionTwoItem,
        selectedVersionId: 'version-3',
        versionNumber: 3,
        path: 'artifact-version:project-1/session-1/artifact-1/version-3'
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      selectedVersionId: 'version-3',
      versionNumber: 3
    })
    expect(getLineage).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('v3')
    expect(previewContentSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({
          selectedVersionId: 'version-3',
          versionNumber: 3,
          path: 'artifact-version:project-1/session-1/artifact-1/version-3'
        })
      })
    )
  })

  it('refreshes version navigation when finalization increments the Session file revision', async () => {
    const getLineage = vi
      .fn()
      .mockResolvedValueOnce({
        artifactId: 'artifact-1',
        filename: 'sin.png',
        originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
        versions: [descriptor, secondDescriptor]
      })
      .mockResolvedValueOnce({
        artifactId: 'artifact-1',
        filename: 'sin.png',
        originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
        versions: [descriptor, secondDescriptor, thirdDescriptor]
      })
    window.api.artifacts.getLineage = getLineage
    const session: ChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Sine',
      cwd: '/workspace',
      status: 'idle',
      messages: [],
      artifacts: [],
      filesRevision: 1,
      createdAt: 1,
      updatedAt: 1
    }
    useSessionStore.setState({ sessions: [session], selectedSessionId: session.id })
    const versionTwoItem = {
      ...item,
      selectedVersionId: 'version-2',
      versionNumber: 2,
      path: 'artifact-version:project-1/session-1/artifact-1/version-2'
    }

    await act(async () => {
      root.render(<PreviewFileSurface item={versionTwoItem} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Next Artifact version"]')
        ?.disabled
    ).toBe(true)

    await act(async () => {
      useSessionStore.setState({
        sessions: [{ ...session, filesRevision: 2, updatedAt: 2 }]
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getLineage).toHaveBeenCalledTimes(2)
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Next Artifact version"]')
        ?.disabled
    ).toBe(false)
    expect(container.textContent).toContain('v2')
  })

  it('opens its menu above an expanded preview modal', async () => {
    await act(async () => {
      root.render(
        <section role="dialog" className="z-[61]">
          <PreviewFileSurface item={item} onClose={vi.fn()} />
        </section>
      )
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))

    const dialog = container.querySelector('[role="dialog"]')
    const menu = document.body.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    expect(menu?.textContent).toContain('Provenance')
    expect(zIndexFromClassName(menu!)).toBeGreaterThan(zIndexFromClassName(dialog!))
  })
})
