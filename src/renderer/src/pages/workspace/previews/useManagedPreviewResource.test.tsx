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
  name: 'first.pdf',
  format: 'pdf'
}

const secondItem: PreviewFileItem = {
  ...firstItem,
  id: 'upload:second.pdf',
  source: 'upload',
  path: '/managed/second.pdf',
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
      path: '/managed/first.pdf'
    })
    expect(container.textContent).toBe('resource-1')

    await act(async () => root.render(<Probe item={secondItem} />))

    expect(window.api.previewResources.release).toHaveBeenCalledWith({ resourceId: 'resource-1' })
    expect(window.api.previewResources.acquire).toHaveBeenLastCalledWith({
      source: 'upload',
      path: '/managed/second.pdf'
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
})
