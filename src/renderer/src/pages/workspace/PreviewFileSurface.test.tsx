// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  type PreviewFileItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
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
  projectId: 'project-1',
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

const localItem: PreviewFileItem = {
  id: 'local:/Users/example/logs/proxy.log',
  sessionId: '__local_files__',
  type: 'file',
  title: 'proxy.log',
  name: 'proxy.log',
  path: '/Users/example/logs/proxy.log',
  format: 'text',
  source: 'local'
}

const setupLocalApi = (): void => {
  window.api.localFs = {
    reveal: vi.fn(),
    openPath: vi.fn()
  } as unknown as typeof window.api.localFs
  window.api.saveManagedFile = vi.fn().mockResolvedValue({ saved: true })
  window.api.uploads = {
    stageLocalPath: vi
      .fn()
      .mockResolvedValue({ id: 'attachment-1', path: '/managed/.pending/proxy.log' })
  } as unknown as typeof window.api.uploads
}

const clickMenuItem = async (label: string): Promise<void> => {
  const menuItem = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent?.includes(label)
  )
  if (!menuItem) throw new Error(`menu item not found: ${label}`)
  await click(menuItem)
}

describe('PreviewFileSurface local file header', () => {
  beforeEach(() => {
    setupLocalApi()
  })

  it('shows a This computer pill before the file path in a light style', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })

    const pathLine = container.querySelector('[data-testid="local-file-path"]')
    expect(pathLine?.textContent).toBe('This computer/Users/example/logs/proxy.log')
    expect(pathLine?.className).toContain('text-text-100')
    expect(pathLine?.querySelector('span')?.className).toContain('rounded-full')
  })

  it('offers a reload button instead of a standalone reveal button', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })

    expect(container.querySelector('[aria-label="Reveal in Finder"]')).toBeNull()
    previewContentSpy.mockClear()

    await click(container.querySelector('[aria-label="Reload file"]'))

    // Reload remounts the content tree so the preview is re-read from disk.
    expect(previewContentSpy).toHaveBeenCalled()
  })

  it('groups the menu per the local-file design: identity header, Copy path, On this machine', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })
    await openMenu(container.querySelector('[aria-label="More actions"]'))

    const menu = document.body.querySelector('[role="menu"]')
    // The menu opens with the file identity: name above the full path in a light tone.
    expect(menu?.textContent).toContain('proxy.log')
    expect(menu?.textContent).toContain('/Users/example/logs/proxy.log')
    expect(menu?.textContent).toContain('Copy path')
    expect(menu?.textContent).toContain('On this machine')
    expect(menu?.textContent).toContain('Download')
    expect(menu?.textContent).toContain('Save as artifact')
    expect(menu?.textContent).not.toContain('Reveal in Finder')
    expect(menu?.textContent).not.toContain('Open with default app')
    expect(menu?.textContent).not.toContain('Annotate')
    expect(menu?.textContent).not.toContain('Delete')

    await clickMenuItem('Download')

    expect(window.api.saveManagedFile).toHaveBeenCalledWith({
      source: 'local',
      path: '/Users/example/logs/proxy.log',
      suggestedName: 'proxy.log'
    })
  })

  it('opens its menu above an expanded preview modal', async () => {
    await act(async () => {
      root.render(
        <section role="dialog" className="z-[61]">
          <PreviewFileSurface item={localItem} onClose={vi.fn()} />
        </section>
      )
    })

    await openMenu(container.querySelector('[aria-label="More actions"]'))

    const dialog = container.querySelector('[role="dialog"]')
    const menu = document.body.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    expect(menu?.textContent).toContain('Save as artifact')
    expect(zIndexFromClassName(menu!)).toBeGreaterThan(zIndexFromClassName(dialog!))
  })

  it('shows no tooltip for the More actions trigger', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })
    const trigger = container.querySelector('[aria-label="More actions"]')!

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 300))
    })

    // Tooltip content carries bg-text-000; the dropdown menu content (bg-popover) must not match.
    expect(
      document.body.querySelector('[data-radix-popper-content-wrapper] .bg-text-000')
    ).toBeNull()
  })

  it('saves as artifact, then swaps the menu item for a saved chip', async () => {
    await act(async () => {
      root.render(<PreviewFileSurface item={localItem} onClose={vi.fn()} />)
    })
    await openMenu(container.querySelector('[aria-label="More actions"]'))
    await clickMenuItem('Save as artifact')

    expect(window.api.uploads.stageLocalPath).toHaveBeenCalledWith({
      transferId: expect.any(String),
      name: 'proxy.log',
      sourcePath: '/Users/example/logs/proxy.log'
    })
    const chip = container.querySelector('[data-testid="saved-as-artifact"]')
    expect(chip).not.toBeNull()
    // The Saved chip leads the local action cluster, ahead of the reload button.
    const reload = container.querySelector('[aria-label="Reload file"]')
    expect(chip!.compareDocumentPosition(reload!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await openMenu(container.querySelector('[aria-label="More actions"]'))
    expect(document.body.querySelector('[role="menu"]')?.textContent).not.toContain(
      'Save as artifact'
    )
  })
})

const originSession: ChatSession = {
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

const otherSession: ChatSession = {
  ...originSession,
  id: 'session-2',
  title: 'Other',
  updatedAt: 2
}

const seedWorkspaceStores = (): void => {
  useProjectStore.setState({
    projects: [
      {
        id: 'project-1',
        name: 'Project One',
        description: '',
        isExample: false,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    isLoaded: true
  })
  useSessionStore.setState({
    sessions: [originSession, otherSession],
    selectedSessionId: 'session-2'
  })
  useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })
}

describe('PreviewFileSurface View in context entry', () => {
  it('switches the conversation to the artifact origin session from the panel menu', async () => {
    seedWorkspaceStores()

    await act(async () => {
      root.render(<PreviewFileSurface item={item} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))
    await clickMenuItem('View in context')

    expect(useSessionStore.getState().selectedSessionId).toBe('session-1')
  })

  it('does not offer View in context for uploaded inputs', async () => {
    seedWorkspaceStores()

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, id: 'upload-1', artifactId: undefined, source: 'upload' }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label^="File actions for"]')).toBeNull()
  })

  it('hides View in context but keeps Provenance when the origin session is deleted', async () => {
    seedWorkspaceStores()

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, originSession: { state: 'deleted', deletedAt: '2026-08-01' } }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))

    const menu = document.body.querySelector('[role="menu"]')
    expect(menu?.textContent).toContain('Provenance')
    expect(menu?.textContent).not.toContain('View in context')
  })

  it('hides View in context while the origin session is deleting', async () => {
    seedWorkspaceStores()
    // Until a newer lineage projection resolves, the item snapshot is the only lifecycle signal.
    window.api.artifacts.getLineage = vi.fn().mockRejectedValue(new Error('lineage unavailable'))

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, originSession: { state: 'deleting' } }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))

    const menu = document.body.querySelector('[role="menu"]')
    expect(menu?.textContent).toContain('Provenance')
    expect(menu?.textContent).not.toContain('View in context')
  })

  it('lets the lineage report of a deleted origin session override the stale item snapshot', async () => {
    seedWorkspaceStores()
    // The preview tab still carries its creation-time snapshot; the refetched lineage is the
    // authority once it resolves with the post-deletion state.
    window.api.artifacts.getLineage = vi.fn().mockResolvedValue({
      artifactId: 'artifact-1',
      filename: 'sin.png',
      originSession: { sessionId: 'session-1', state: 'deleted', title: 'Sine' },
      versions: [descriptor, secondDescriptor]
    })

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, originSession: { state: 'active' } }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))

    const menu = document.body.querySelector('[role="menu"]')
    expect(menu?.textContent).toContain('Provenance')
    expect(menu?.textContent).not.toContain('View in context')
  })

  it('lets the lineage report of a deleting origin session override the stale item snapshot', async () => {
    seedWorkspaceStores()
    window.api.artifacts.getLineage = vi.fn().mockResolvedValue({
      artifactId: 'artifact-1',
      filename: 'sin.png',
      originSession: { sessionId: 'session-1', state: 'deleting', title: 'Sine' },
      versions: [descriptor, secondDescriptor]
    })

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, originSession: { state: 'active' } }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))

    const menu = document.body.querySelector('[role="menu"]')
    expect(menu?.textContent).toContain('Provenance')
    expect(menu?.textContent).not.toContain('View in context')
  })

  it('lets active lineage restore View in context after a deleting item snapshot is compensated', async () => {
    seedWorkspaceStores()
    window.api.artifacts.getLineage = vi.fn().mockResolvedValue({
      artifactId: 'artifact-1',
      filename: 'sin.png',
      originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
      versions: [descriptor, secondDescriptor]
    })

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, originSession: { state: 'deleting' } }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))

    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain('View in context')
  })

  it('stops using active lineage while a newer deleting item snapshot is refreshing', async () => {
    seedWorkspaceStores()
    const getLineage = vi
      .fn()
      .mockResolvedValueOnce({
        artifactId: 'artifact-1',
        filename: 'sin.png',
        originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
        versions: [descriptor, secondDescriptor]
      })
      .mockImplementationOnce(() => new Promise(() => undefined))
    window.api.artifacts.getLineage = getLineage

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, originSession: { state: 'active' } }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={{ ...item, originSession: { state: 'deleting' } }}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))

    expect(getLineage).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[role="menu"]')?.textContent).not.toContain(
      'View in context'
    )
  })

  it('does not notify View in context consumers when the guard rejects the navigation', async () => {
    seedWorkspaceStores()
    // The origin session vanished after render (deleted mid-flight): the guard must reject the
    // open, and the full-screen dialog must stay open on the un-navigated surface.
    useSessionStore.setState({ sessions: [otherSession], selectedSessionId: 'session-2' })
    const onViewInContextNavigate = vi.fn()

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={item}
          provenanceEntry="trailing"
          onViewInContextNavigate={onViewInContextNavigate}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await click(container.querySelector('[aria-label="View in context for sin.png"]'))

    expect(useSessionStore.getState().selectedSessionId).toBe('session-2')
    expect(onViewInContextNavigate).not.toHaveBeenCalled()
  })

  it('keeps View in context visible but inert when the origin session is archived', async () => {
    seedWorkspaceStores()
    useSessionStore.setState({
      sessions: [{ ...originSession, archivedAt: 5 }, otherSession],
      selectedSessionId: 'session-2'
    })

    await act(async () => {
      root.render(<PreviewFileSurface item={item} onClose={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    await openMenu(container.querySelector('[aria-label="File actions for sin.png"]'))
    const menuItem = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (element) => element.textContent?.includes('View in context')
    )
    expect(menuItem?.getAttribute('aria-disabled')).toBe('true')
    // The reason reads inline, matching the disabled-item precedent in AgentInstallSourceMenu.
    expect(menuItem?.textContent).toContain('Source conversation is archived')

    await click(menuItem ?? null)

    expect(useSessionStore.getState().selectedSessionId).toBe('session-2')
  })

  it('navigates and notifies from the full-screen trailing entry', async () => {
    seedWorkspaceStores()
    const onViewInContextNavigate = vi.fn()

    await act(async () => {
      root.render(
        <PreviewFileSurface
          item={item}
          provenanceEntry="trailing"
          onViewInContextNavigate={onViewInContextNavigate}
          onClose={vi.fn()}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    await click(container.querySelector('[aria-label="View in context for sin.png"]'))

    expect(useSessionStore.getState().selectedSessionId).toBe('session-1')
    expect(onViewInContextNavigate).toHaveBeenCalledOnce()
  })
})
