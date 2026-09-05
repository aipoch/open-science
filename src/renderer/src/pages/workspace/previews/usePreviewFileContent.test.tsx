// @vitest-environment jsdom
import { act, StrictMode } from 'react'
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
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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

  it.each([
    ['artifact', '11112222', undefined],
    ['upload', '11112222', undefined],
    ['artifact', '11', undefined],
    ['upload', '11', undefined],
    ['artifact', '11112222', 'old'],
    ['upload', '11112222', 'old']
  ] as const)(
    'keeps %s pages on one version when the new head is %s (selection: %s)',
    async (source, newHead, selectedVersionId) => {
      const versions: Record<string, string> = { old: 'AAAABBBB', new: newHead }
      let head = 'old'
      let nextId = 0
      const resources = new Map<string, string>()
      vi.mocked(window.api.previewResources.acquire).mockImplementation(async (request) => {
        if (request.source !== 'artifact' && request.source !== 'upload') {
          throw new Error('Expected a managed version request.')
        }
        // A capability pins the version resolved at acquisition, until release.
        const content = versions[request.versionId ?? head]
        const id = String(++nextId)
        const url = `https://preview.test/${id}`
        resources.set(url, content)
        return { id, url, size: content.length, mimeType: 'text/plain', version: nextId }
      })
      vi.mocked(window.api.previewResources.release).mockImplementation(async ({ resourceId }) => {
        resources.delete(`https://preview.test/${resourceId}`)
      })
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const content = resources.get(String(input))
        if (content === undefined) throw new Error('Preview resource has been released.')
        const range = new Headers(init?.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/u)
        if (!range) throw new Error('Expected a byte range.')
        const begin = Number(range[1])
        const end = Math.min(Number(range[2]) + 1, content.length)
        return new Response(content.slice(begin, end), {
          status: 206,
          headers: { 'Content-Range': `bytes ${begin}-${end - 1}/${content.length}` }
        })
      })

      const PaginatedProbe = ({ fileId = 'file-1' }: { fileId?: string }): React.JSX.Element => {
        const state = usePreviewFileContent({
          projectId: 'project-1',
          managedFileId: fileId,
          selectedVersionId,
          source,
          path: '/managed/file.txt',
          maxBytes: 4
        })
        return state.status === 'ready' ? (
          <>
            <button type="button" aria-label="Next page" onClick={state.pagination.nextPage}>
              {state.preview.content}
            </button>
            <button
              type="button"
              aria-label="Previous page"
              onClick={state.pagination.previousPage}
            />
          </>
        ) : (
          <div>{state.status === 'error' ? String(state.error) : state.status}</div>
        )
      }

      root = createRoot(container)
      await act(async () => root.render(<PaginatedProbe />))
      expect(container.textContent).toBe('AAAA')

      // Publish between completed page reads, before any refresh notification.
      head = 'new'
      await act(async () => container.querySelector('button')?.click())
      expect(container.textContent).toBe('BBBB')
      expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(1)
      expect(window.api.previewResources.release).not.toHaveBeenCalled()

      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Previous page"]')?.click()
      )
      expect(container.textContent).toBe('AAAA')
      await act(async () => container.querySelector('button')?.click())
      expect(container.textContent).toBe('BBBB')

      // Identity switches start at zero, including returning to a previously paged file.
      await act(async () => root.render(<PaginatedProbe fileId="file-2" />))
      expect(container.textContent).toBe(selectedVersionId ? 'AAAA' : newHead.slice(0, 4))
      await act(async () => root.render(<PaginatedProbe />))
      expect(container.textContent).toBe(selectedVersionId ? 'AAAA' : newHead.slice(0, 4))
      expect(resources.size).toBe(1)

      head = 'old'
      await act(async () => root.render(<PaginatedProbe fileId="file-3" />))
      await act(async () => container.querySelector('button')?.click())
      expect(container.textContent).toBe('BBBB')
      head = 'new'
      // Refresh/retry uses the existing renderer-remount boundary.
      await act(async () => root.render(<PaginatedProbe key="refresh" fileId="file-3" />))
      expect(container.textContent).toBe(selectedVersionId ? 'AAAA' : newHead.slice(0, 4))
      expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(5)
      expect(window.api.previewResources.release).toHaveBeenCalledTimes(4)
      await act(async () => root.render(null))
      expect(resources.size).toBe(0)
      expect(window.api.previewResources.release).toHaveBeenCalledTimes(5)
    }
  )

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
    expect(container.textContent).toBe('group,count\nA,2')
    expect(window.api.previewResources.release).not.toHaveBeenCalled()
    await act(async () => root.render(null))
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'resource:upload-file-1'
    })
  })

  it.each(['unmount', 'switch', 'strict-mode'] as const)(
    'releases an acquisition completed after %s without reading it',
    async (action) => {
      const stale = {
        id: 'stale',
        url: 'https://preview.test/stale',
        size: 8,
        mimeType: 'text/plain',
        version: 1
      }
      let finishAcquire!: (resource: typeof stale) => void
      vi.mocked(window.api.previewResources.acquire).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishAcquire = resolve
          })
      )
      root = createRoot(container)
      await act(async () =>
        root.render(
          action === 'strict-mode' ? (
            <StrictMode>
              <Probe />
            </StrictMode>
          ) : (
            <Probe />
          )
        )
      )
      if (action !== 'strict-mode') {
        await act(async () =>
          root.render(action === 'unmount' ? null : <SwitchingProbe fileId="second" />)
        )
      }
      await act(async () => finishAcquire(stale))

      expect(window.api.previewResources.release).toHaveBeenCalledWith({ resourceId: 'stale' })
      expect(vi.mocked(fetch).mock.calls.some(([url]) => url === stale.url)).toBe(false)
      expect(
        vi
          .mocked(window.api.previewResources.release)
          .mock.calls.filter(([request]) => request.resourceId === 'stale')
      ).toHaveLength(1)
    }
  )

  it.each(['local', 'notebook-input'] as const)(
    'continues releasing %s resources after each read',
    async (source) => {
      const PathProbe = (): React.JSX.Element => {
        const state = usePreviewFileContent({
          source,
          path: '/input.txt',
          projectId: 'project-1',
          sessionId: 'session-1'
        })
        return <div>{state.status}</div>
      }
      vi.mocked(window.api.previewResources.acquire).mockResolvedValue({
        id: 'path',
        url: 'https://preview.test/path',
        size: 15,
        mimeType: 'text/plain',
        version: 1
      })
      root = createRoot(container)
      await act(async () => root.render(<PathProbe />))
      expect(container.textContent).toBe('ready')
      expect(window.api.previewResources.release).toHaveBeenCalledExactlyOnceWith({
        resourceId: 'path'
      })
    }
  )

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

  it('does not expose old page offsets when returning while another file is still loading', async () => {
    root = createRoot(container)
    await act(async () => root.render(<SwitchingProbe fileId="first" />))
    expect(container.textContent).toBe('ready')
    vi.mocked(fetch).mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    )
    await act(async () => root.render(<SwitchingProbe fileId="second" />))
    expect(container.textContent).toBe('loading')
    await act(async () => root.render(<SwitchingProbe fileId="first" />))
    expect(container.textContent).toBe('loading')
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
