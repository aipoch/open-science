// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
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
