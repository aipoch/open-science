// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePreviewFileContent } from './usePreviewFileContent'

const Probe = (): React.JSX.Element => {
  const state = usePreviewFileContent({
    projectId: 'project-1',
    sessionId: 'active-session',
    source: 'upload',
    managedFileId: 'upload-file-1',
    selectedVersionId: 'upload-version-1',
    path: 'upload-version:project-1/source-session/upload-version-1'
  })

  return <div>{state.status === 'ready' ? state.preview.content : state.status}</div>
}

const SwitchingProbe = ({ fileId }: { fileId: string }): React.JSX.Element => {
  const state = usePreviewFileContent({
    projectId: 'project-1',
    sessionId: 'session-1',
    source: 'upload',
    managedFileId: fileId,
    path: `/managed/${fileId}.txt`
  })

  return <div>{state.status}</div>
}

describe('usePreviewFileContent', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    window.api = {
      previewResources: {
        acquire: vi.fn(async (request) => {
          const identity = request.source === 'local' ? request.path : request.fileId
          return {
            id: `resource:${identity}`,
            url: `https://preview.test/${encodeURIComponent(identity)}`,
            size: 15,
            mimeType: 'text/plain',
            version: 1
          }
        }),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      },
      uploads: {
        readPreview: vi.fn().mockResolvedValue({
          content: 'group,count\nA,2',
          encoding: 'utf8',
          size: 15,
          truncated: false
        })
      }
    } as unknown as Window['api']
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('group,count\nA,2', { status: 206 }))
    )
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('keeps project and session scope when acquiring a version-backed upload', async () => {
    root = createRoot(container)
    await act(async () => root.render(<Probe />))

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      projectId: 'project-1',
      source: 'upload',
      fileId: 'upload-file-1',
      versionId: 'upload-version-1',
      maxBytes: 1024 * 1024
    })
    expect(fetch).toHaveBeenCalledWith('https://preview.test/upload-file-1', {
      cache: 'no-store',
      headers: { Range: 'bytes=0-14' },
      signal: expect.any(AbortSignal)
    })
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'resource:upload-file-1'
    })
    expect(container.textContent).toBe('group,count\nA,2')
  })

  it('does not leave concurrent direct preview reads when switching files', async () => {
    let activeDirectReads = 0
    vi.mocked(window.api.uploads.readPreview).mockImplementation(
      () =>
        new Promise(() => {
          activeDirectReads += 1
        })
    )
    const signals: AbortSignal[] = []
    vi.mocked(fetch).mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal
          if (!(signal instanceof AbortSignal)) throw new Error('Preview fetch signal is missing.')
          signals.push(signal)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    root = createRoot(container)

    await act(async () => root.render(<SwitchingProbe fileId="first" />))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await act(async () => root.render(<SwitchingProbe fileId="second" />))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

    expect(activeDirectReads).toBeLessThanOrEqual(1)
    expect(signals[0]?.aborted).toBe(true)
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'resource:first'
    })
  })

  it('requests the next UTF-8 page from the previous byte boundary', async () => {
    vi.mocked(window.api.previewResources.acquire).mockResolvedValue({
      id: 'resource:utf8',
      url: 'https://preview.test/utf8',
      size: 8,
      mimeType: 'text/plain',
      version: 1
    })
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(new TextEncoder().encode('abcé'), { status: 206 }))
      .mockResolvedValueOnce(new Response(new TextEncoder().encode('xyz'), { status: 206 }))

    const PaginatedProbe = (): React.JSX.Element => {
      const state = usePreviewFileContent({
        projectId: 'project-1',
        sessionId: 'session-1',
        source: 'upload',
        managedFileId: 'utf8-file',
        path: '/managed/utf8.txt',
        maxBytes: 4
      })
      return state.status === 'ready' ? (
        <button type="button" onClick={state.pagination.nextPage}>
          {state.preview.content}
        </button>
      ) : (
        <div>{state.status}</div>
      )
    }

    root = createRoot(container)
    await act(async () => root.render(<PaginatedProbe />))
    expect(container.textContent).toBe('abcé')

    await act(async () => container.querySelector('button')?.click())

    expect(fetch).toHaveBeenLastCalledWith(
      'https://preview.test/utf8',
      expect.objectContaining({ headers: { Range: 'bytes=5-7' } })
    )
    expect(container.textContent).toBe('xyz')
  })
})
