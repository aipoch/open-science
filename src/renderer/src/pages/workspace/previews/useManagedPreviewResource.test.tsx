// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import {
  WEB_EVENT_CONNECTION_STATE_EVENT,
  WEB_EVENTS_OPEN_EVENT,
  WEB_EVENT_SURFACE_ATTRIBUTE
} from '../../../../../shared/web-event-connection'
import { PreviewRuntimeBoundary } from './preview-runtime'
import { useManagedPreviewResource } from './useManagedPreviewResource'

const firstItem: PreviewFileItem = {
  id: 'artifact:first.pdf',
  sessionId: 'session-1',
  title: 'first.pdf',
  type: 'file',
  source: 'artifact',
  path: '/managed/first.pdf',
  projectId: 'project-1',
  managedFileId: 'artifact-1',
  name: 'first.pdf',
  format: 'pdf'
}

const secondItem: PreviewFileItem = {
  ...firstItem,
  id: 'upload:second.pdf',
  projectId: 'project-1',
  sessionId: 'active-session',
  source: 'upload',
  path: 'upload-version:project-1/source-session/upload-version-2',
  managedFileId: 'upload-2',
  name: 'second.pdf',
  title: 'second.pdf'
}

const Probe = ({
  item,
  enabled = true
}: {
  item: PreviewFileItem
  enabled?: boolean
}): React.JSX.Element => {
  const state = useManagedPreviewResource(item, enabled)

  return <div data-state={state.status}>{state.resource?.id}</div>
}

const StrictProbe = ({
  item,
  maxBytes
}: {
  item: PreviewFileItem
  maxBytes: number
}): React.JSX.Element => {
  const state = useManagedPreviewResource({ ...item, maxBytes })

  return <div data-state={state.status}>{state.resource?.id}</div>
}

describe('useManagedPreviewResource', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    window.api = {
      previewResources: {
        acquire: vi.fn(),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container.remove()
  })

  it('W01 reads from a fresh capability after replay while the preview stays mounted', async () => {
    document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
    const activeResources = new Set<string>()
    let nextId = 0
    vi.mocked(window.api.previewResources.acquire).mockImplementation(async () => {
      const id = `resource-${++nextId}`
      activeResources.add(id)
      return { id, url: `/preview/${id}`, size: 3, mimeType: 'application/pdf', version: 1 }
    })
    vi.mocked(window.api.previewResources.readRange).mockImplementation(async ({ resourceId }) => {
      if (!activeResources.has(resourceId))
        throw new Error('Managed preview resource is unavailable.')
      return { begin: 0, end: 3, total: 3, data: new Uint8Array([1, 2, 3]) }
    })
    const LazyReader = (): React.JSX.Element => {
      const state = useManagedPreviewResource(firstItem)
      const [result, setResult] = useState('')
      return (
        <>
          <button
            disabled={!state.resource}
            onClick={() => {
              if (!state.resource) return
              void window.api.previewResources
                .readRange({ resourceId: state.resource.id, begin: 0, end: 3 })
                .then(
                  (value) => setResult(Array.from(value.data).join(',')),
                  (error) => setResult(error.message)
                )
            }}
          >
            Read next range
          </button>
          <output>{result}</output>
        </>
      )
    }
    const phase = (value: string): void => {
      window.dispatchEvent(
        new CustomEvent(WEB_EVENT_CONNECTION_STATE_EVENT, { detail: { phase: value } })
      )
    }
    try {
      root = createRoot(container)
      await act(async () =>
        root.render(
          <PreviewRuntimeBoundary item={firstItem}>
            <LazyReader />
          </PreviewRuntimeBoundary>
        )
      )
      await act(async () => {
        phase('live')
        window.dispatchEvent(new Event(WEB_EVENTS_OPEN_EVENT))
      })
      await act(async () => container.querySelector('button')?.click())
      expect(container.querySelector('output')?.textContent).toBe('1,2,3')
      // The HTTP/Socket owner contract revokes capabilities on the last idle socket close.
      activeResources.clear()
      await act(async () => phase('reconnecting'))
      await act(async () => phase('replaying'))
      await act(async () => {
        phase('live')
        window.dispatchEvent(new Event(WEB_EVENTS_OPEN_EVENT))
      })
      await act(async () => container.querySelector('button')?.click())
      expect(window.api.previewResources.readRange).toHaveBeenCalledTimes(2)
      expect(container.querySelector('output')?.textContent).toBe('1,2,3')
    } finally {
      document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
    }
  })

  it.each([false, true])('refreshes only after Web recovery (Web surface: %s)', async (web) => {
    document.documentElement.toggleAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, web)
    if (web) document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
    let id = 0
    vi.mocked(window.api.previewResources.acquire).mockImplementation(async () => ({
      id: `resource-${++id}`,
      url: '/preview',
      size: 3,
      mimeType: 'application/pdf',
      version: 1
    }))
    const phase = async (value: string): Promise<void> => {
      await act(async () =>
        window.dispatchEvent(
          new CustomEvent(WEB_EVENT_CONNECTION_STATE_EVENT, { detail: { phase: value } })
        )
      )
    }
    try {
      root = createRoot(container)
      await act(async () => root.render(<Probe item={firstItem} />))
      await phase('live')
      await phase('live')
      expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
      for (let retry = 1; retry <= 2; retry += 1) {
        await phase('reconnecting')
        await phase('replaying')
        expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(web ? retry : 1)
        await phase('live')
        await phase('live')
        expect(container.textContent).toBe(`resource-${web ? retry + 1 : 1}`)
        expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(web ? retry + 1 : 1)
      }
    } finally {
      document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
    }
  })

  it('releases a late pre-recovery acquire without replacing the new resource', async () => {
    document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
    const late =
      Promise.withResolvers<Awaited<ReturnType<Window['api']['previewResources']['acquire']>>>()
    const resource = {
      id: 'fresh',
      url: '/preview/fresh',
      size: 3,
      mimeType: 'application/pdf',
      version: 1
    }
    vi.mocked(window.api.previewResources.acquire)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(resource)
    vi.mocked(window.api.previewResources.release).mockRejectedValue(
      new Error('Transport disconnected')
    )
    try {
      root = createRoot(container)
      await act(async () => root.render(<Probe item={firstItem} />))
      for (const phase of ['reconnecting', 'live']) {
        await act(async () =>
          window.dispatchEvent(
            new CustomEvent(WEB_EVENT_CONNECTION_STATE_EVENT, { detail: { phase } })
          )
        )
      }
      expect(container.textContent).toBe('fresh')
      await act(async () => late.resolve({ ...resource, id: 'obsolete' }))
      expect(container.textContent).toBe('fresh')
      expect(window.api.previewResources.release).toHaveBeenCalledWith({ resourceId: 'obsolete' })
    } finally {
      document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
      late.resolve({ ...resource, id: 'obsolete' })
    }
  })

  it('acquires on mount and releases when the file changes or unmounts', async () => {
    vi.mocked(window.api.previewResources.acquire)
      .mockResolvedValueOnce({
        id: 'resource-1',
        url: 'open-science-preview://resource-1/first.pdf',
        size: 12,
        mimeType: 'application/pdf',
        version: 1
      })
      .mockResolvedValueOnce({
        id: 'resource-2',
        url: 'open-science-preview://resource-2/second.pdf',
        size: 20,
        mimeType: 'application/pdf',
        version: 2
      })
    root = createRoot(container)

    await act(async () => root.render(<Probe item={firstItem} />))

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-1'
    })
    expect(container.textContent).toBe('resource-1')

    await act(async () => root.render(<Probe item={secondItem} />))

    expect(window.api.previewResources.release).toHaveBeenCalledWith({ resourceId: 'resource-1' })
    expect(window.api.previewResources.acquire).toHaveBeenLastCalledWith({
      source: 'upload',
      projectId: 'project-1',
      fileId: 'upload-2'
    })
    expect(container.textContent).toBe('resource-2')

    await act(async () => root.unmount())
    expect(window.api.previewResources.release).toHaveBeenLastCalledWith({
      resourceId: 'resource-2'
    })
  })

  it('releases a late acquire result after the component is disabled', async () => {
    let resolveAcquire:
      | ((resource: Awaited<ReturnType<Window['api']['previewResources']['acquire']>>) => void)
      | undefined
    vi.mocked(window.api.previewResources.acquire).mockReturnValue(
      new Promise((resolve) => {
        resolveAcquire = resolve
      })
    )
    root = createRoot(container)

    await act(async () => root.render(<Probe item={firstItem} />))
    await act(async () => root.render(<Probe item={firstItem} enabled={false} />))
    await act(async () => {
      resolveAcquire?.({
        id: 'late-resource',
        url: 'open-science-preview://late-resource/first.pdf',
        size: 12,
        mimeType: 'application/pdf',
        version: 1
      })
    })

    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'late-resource'
    })
    expect(container.querySelector('div')?.dataset.state).toBe('idle')
  })

  it('reacquires the same path when its version metadata changes', async () => {
    vi.mocked(window.api.previewResources.acquire)
      .mockResolvedValueOnce({
        id: 'resource-v1',
        url: 'open-science-preview://resource-v1/first.pdf',
        size: 12,
        mimeType: 'application/pdf',
        version: 1
      })
      .mockResolvedValueOnce({
        id: 'resource-v2',
        url: 'open-science-preview://resource-v2/first.pdf',
        size: 14,
        mimeType: 'application/pdf',
        version: 2
      })
    const versionedItem = { ...firstItem, size: 12, mtimeMs: 1 }
    root = createRoot(container)

    await act(async () => root.render(<Probe item={versionedItem} />))
    await act(async () => root.render(<Probe item={{ ...versionedItem, size: 14, mtimeMs: 2 }} />))

    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(2)
    expect(window.api.previewResources.release).toHaveBeenCalledWith({ resourceId: 'resource-v1' })
    expect(container.textContent).toBe('resource-v2')
  })

  it('passes a strict byte limit through capability acquisition', async () => {
    vi.mocked(window.api.previewResources.acquire).mockResolvedValue({
      id: 'strict-resource',
      url: 'open-science-preview://strict-resource/first.pdf',
      size: 12,
      mimeType: 'application/pdf',
      version: 1
    })
    root = createRoot(container)

    await act(async () => root.render(<StrictProbe item={firstItem} maxBytes={4096} />))

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'artifact',
      projectId: 'project-1',
      fileId: 'artifact-1',
      maxBytes: 4096
    })
  })

  it.each(['artifact', 'upload'] as const)(
    'returns an error without acquiring when a %s has no logical file identity',
    async (source) => {
      const item: PreviewFileItem = {
        ...firstItem,
        id: source === 'upload' ? 'upload:legacy-file' : 'legacy-artifact-version',
        source,
        path: '/managed/legacy-file.html',
        name: 'legacy-file.html',
        title: 'legacy-file.html',
        format: 'html',
        managedFileId: undefined,
        ...(source === 'upload' ? { artifactId: 'artifact-from-wrong-source' } : {})
      }
      root = createRoot(container)

      await act(async () => root.render(<Probe item={item} />))

      expect(container.querySelector('div')?.dataset.state).toBe('error')
      expect(window.api.previewResources.acquire).not.toHaveBeenCalled()
    }
  )

  it('returns an error when capability acquisition rejects asynchronously', async () => {
    vi.mocked(window.api.previewResources.acquire).mockRejectedValue(
      new Error('Capability acquisition failed')
    )
    root = createRoot(container)

    await act(async () => root.render(<Probe item={firstItem} />))

    expect(container.querySelector('div')?.dataset.state).toBe('error')
    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
  })

  it('does not let a stale acquisition error replace the current resource', async () => {
    let rejectFirstAcquire: ((reason: Error) => void) | undefined
    vi.mocked(window.api.previewResources.acquire).mockImplementation((request) => {
      if (request.source === 'artifact') {
        return new Promise((_, reject) => {
          rejectFirstAcquire = reject
        })
      }
      return Promise.resolve({
        id: 'current-resource',
        url: 'open-science-preview://current-resource/second.pdf',
        size: 20,
        mimeType: 'application/pdf',
        version: 1
      })
    })
    root = createRoot(container)

    await act(async () => root.render(<Probe item={firstItem} />))
    await act(async () => root.render(<Probe item={secondItem} />))
    expect(container.textContent).toBe('current-resource')

    await act(async () => rejectFirstAcquire?.(new Error('Stale acquisition failed')))

    expect(container.querySelector('div')?.dataset.state).toBe('ready')
    expect(container.textContent).toBe('current-resource')
  })

  it('does not reacquire or release when stable identity props rerender', async () => {
    vi.mocked(window.api.previewResources.acquire).mockResolvedValue({
      id: 'stable-resource',
      url: 'open-science-preview://stable-resource/first.pdf',
      size: 12,
      mimeType: 'application/pdf',
      version: 1
    })
    root = createRoot(container)

    await act(async () => root.render(<Probe item={firstItem} />))
    await act(async () => root.render(<Probe item={{ ...firstItem }} />))

    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
    expect(window.api.previewResources.release).not.toHaveBeenCalled()
    expect(container.textContent).toBe('stable-resource')
  })
})
