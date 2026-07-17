// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import {
  createInitialSessionState,
  type ChatMessage,
  type ChatSession
} from '@/stores/session-store'
import type { UploadedAttachment } from '../../../../shared/uploads'

const createMessage = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'message-1',
  role: 'user',
  content: 'Prompt',
  status: 'complete',
  eventIds: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const createSession = (overrides: Partial<ChatSession>): ChatSession => ({
  id: 'session-1',
  projectId: 'default',
  title: 'Analysis session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  ...overrides
})

const createUpload = (overrides: Partial<UploadedAttachment> = {}): UploadedAttachment => ({
  id: 'upload-1',
  sessionId: 'session-1',
  name: 'safe-name.png',
  originalName: 'user upload.png',
  path: '/Users/example/.open-science/uploads/default-project/session-1/safe-name.png',
  mimeType: 'image/png',
  size: 2048,
  ...overrides
})

const clickDropdownTrigger = (button: HTMLButtonElement | null): void => {
  button?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('buildProjectFileLibrary', () => {
  it('collects all user uploads into one flat newest-first list', async () => {
    const { buildProjectFileLibrary } = await import('./project-files-library')
    const library = buildProjectFileLibrary([
      createSession({
        id: 'session-a',
        title: 'Session A',
        messages: [
          createMessage({
            id: 'old-message',
            createdAt: 1710000000000,
            updatedAt: 1710000001000,
            uploads: [createUpload({ id: 'upload-old', originalName: 'old.fasta' })]
          })
        ]
      }),
      createSession({
        id: 'session-b',
        title: 'Session B',
        messages: [
          createMessage({
            id: 'new-message',
            createdAt: 1710000000000,
            updatedAt: 1710000003000,
            uploads: [createUpload({ id: 'upload-new', originalName: 'new.fasta' })]
          })
        ]
      })
    ])

    expect(library.uploadFiles.map((file) => file.name)).toEqual(['new.fasta', 'old.fasta'])
    expect(library.artifactGroups).toEqual([])
  })

  it('groups generated files by session and filters out non-managed artifacts', async () => {
    const { buildProjectFileLibrary } = await import('./project-files-library')
    const library = buildProjectFileLibrary([
      createSession({
        id: 'session-a',
        title: 'Phylogenetic Analysis',
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/tree.png',
            fileUrl: 'file:///workspace/tree.png',
            name: 'tree.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          },
          {
            id: 'artifact-2',
            kind: 'workspace-file',
            path: '/workspace/raw.txt',
            fileUrl: 'file:///workspace/raw.txt',
            name: 'raw.txt',
            mimeType: 'text/plain',
            size: 128,
            mtimeMs: 1710000002001
          }
        ]
      })
    ])

    expect(library.artifactGroups).toHaveLength(1)
    expect(library.artifactGroups[0]).toMatchObject({
      sessionId: 'session-a',
      title: 'Phylogenetic Analysis',
      files: [
        {
          id: 'artifact-1',
          name: 'tree.png'
        }
      ]
    })
  })
})

describe('ProjectFilesView', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
    container = document.createElement('div')
    document.body.appendChild(container)
    window.api = {
      saveManagedFile: vi.fn().mockResolvedValue({ saved: true }),
      previewResources: {
        acquire: vi.fn(({ path }: { path: string }) =>
          Promise.resolve({
            id: `resource:${path}`,
            url: `open-science-preview://resource/${encodeURIComponent(path)}`,
            size: 40 * 1024 * 1024,
            mimeType: 'image/png',
            version: 1
          })
        ),
        readRange: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined)
      },
      artifacts: {
        readPreview: vi.fn().mockResolvedValue({
          content: 'ZmFrZS1pbWFnZQ==',
          encoding: 'base64',
          size: 10,
          truncated: false
        })
      },
      uploads: {
        readPreview: vi.fn().mockResolvedValue({
          content: 'dXBsb2FkLWltYWdl',
          encoding: 'base64',
          size: 12,
          truncated: false
        })
      }
    } as unknown as Window['api']
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const renderView = async (sessions: ChatSession[], strict = false): Promise<void> => {
    const { useSessionStore } = await import('@/stores/session-store')
    const { useNavigationStore } = await import('@/stores/navigation-store')
    const { ProjectFilesView } = await import('./ProjectFilesView')

    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions
    })
    // The view lists only the active project's files; test sessions use the 'default' projectId.
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'default' })
    root = createRoot(container)
    await act(async () => {
      root.render(strict ? <StrictMode>{<ProjectFilesView />}</StrictMode> : <ProjectFilesView />)
    })
  }

  it('renders an empty state when the project has no files', async () => {
    await renderView([])

    expect(container.querySelector('[data-testid="files-view"]')).not.toBeNull()
    expect(container.textContent).toContain('No files yet')
  })

  it('renders uploaded files under Your uploads without a session group', async () => {
    await renderView([
      createSession({
        title: 'Hidden session title',
        messages: [
          createMessage({
            uploads: [createUpload({ originalName: 'iso621_bridge_recombinase.fasta' })]
          })
        ]
      })
    ])

    expect(container.textContent).toContain('Your uploads')
    expect(container.textContent).toContain('iso621_bridg...inase.fasta')
    expect(container.querySelector('[title="iso621_bridge_recombinase.fasta"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Hidden session title')
    expect(
      container.querySelector('[data-testid="project-file-preview"]')?.parentElement?.parentElement
        ?.className
    ).toContain('focus-within:ring')
  })

  it('downloads an uploaded file without opening its preview', async () => {
    const upload = createUpload()
    await renderView([
      createSession({
        messages: [createMessage({ uploads: [upload] })]
      })
    ])

    const downloadButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Download user upload.png"]'
    )
    expect(downloadButton).not.toBeNull()
    expect(
      downloadButton?.closest('[data-testid="download-tooltip-trigger"]')?.className
    ).toContain('absolute')

    await act(async () => {
      downloadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(window.api.saveManagedFile).toHaveBeenCalledWith({
      source: 'upload',
      path: upload.path,
      suggestedName: 'user upload.png'
    })
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBeUndefined()
  })

  it('downloads a generated file through the artifact source', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-download',
            kind: 'managed-file',
            path: '/workspace/report.pdf',
            fileUrl: 'file:///workspace/report.pdf',
            name: 'report.pdf',
            mimeType: 'application/pdf',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    const downloadButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Download report.pdf"]'
    )
    await act(async () => {
      downloadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(window.api.saveManagedFile).toHaveBeenCalledWith({
      source: 'artifact',
      path: '/workspace/report.pdf',
      suggestedName: 'report.pdf'
    })
  })

  it('opens a filter menu without This computer entries', async () => {
    await renderView([
      createSession({
        title: 'Session A',
        messages: [
          createMessage({
            uploads: [createUpload()]
          })
        ],
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/tree.png',
            fileUrl: 'file:///workspace/tree.png',
            name: 'tree.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )

    await act(async () => {
      clickDropdownTrigger(filterButton)
    })

    expect(document.body.textContent).toContain('All artifacts')
    expect(document.body.textContent).toContain('Your uploads')
    expect(document.body.textContent).toContain('Session A')
    expect(document.body.textContent).not.toContain('This computer')
  })

  it('uses the global semantic menu surface and hover feedback for filter items', async () => {
    await renderView([
      createSession({
        title: 'Session A',
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/tree.png',
            fileUrl: 'file:///workspace/tree.png',
            name: 'tree.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    const filterButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Filter project files"]'
    )

    await act(async () => {
      clickDropdownTrigger(filterButton)
    })

    expect(filterButton?.getAttribute('data-slot')).toBe('button')
    expect(filterButton?.getAttribute('data-variant')).toBe('outline')
    expect(filterButton?.className).toContain('rounded-lg')
    expect(filterButton?.className).toContain('border-border')
    expect(filterButton?.className).toContain('bg-card')
    expect(filterButton?.className).toContain('hover:bg-muted')
    expect(filterButton?.className).not.toContain('rounded-md')
    expect(filterButton?.className).not.toContain('border-border-300')
    expect(filterButton?.className).not.toContain('shadow-sm')
    expect(filterButton?.className).not.toContain('hover:bg-bg-100')
    expect(document.body.querySelector('[data-slot="dropdown-menu-content"]')?.className).toContain(
      'bg-popover'
    )
    expect(document.body.querySelector('[data-filter-id="all"]')?.className).toContain(
      'data-[highlighted]:bg-muted'
    )
  })

  it('filters to uploads or a single session from the menu', async () => {
    await renderView([
      createSession({
        id: 'session-a',
        title: 'Session A',
        messages: [
          createMessage({
            uploads: [createUpload()]
          })
        ],
        artifacts: [
          {
            id: 'artifact-a',
            kind: 'managed-file',
            path: '/workspace/a.png',
            fileUrl: 'file:///workspace/a.png',
            name: 'a.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      }),
      createSession({
        id: 'session-b',
        title: 'Session B',
        artifacts: [
          {
            id: 'artifact-b',
            kind: 'managed-file',
            path: '/workspace/b.png',
            fileUrl: 'file:///workspace/b.png',
            name: 'b.png',
            mimeType: 'image/png',
            size: 2048,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    const openFilterMenu = async (): Promise<void> => {
      const filterButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Filter project files"]'
      )

      await act(async () => {
        clickDropdownTrigger(filterButton)
      })
    }

    await openFilterMenu()
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-filter-id="uploads"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('user upload.png')
    expect(container.textContent).not.toContain('a.png')
    expect(container.textContent).not.toContain('Session B')

    await openFilterMenu()
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-filter-id="session:session-b"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Session B')
    expect(container.textContent).toContain('b.png')
    expect(container.textContent).not.toContain('Your uploads')
    expect(container.textContent).not.toContain('a.png')
  })

  it('shows wrapped size metadata and relative file timestamps', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1710007202000)

    await renderView([
      createSession({
        title: 'Generated session',
        messages: [
          createMessage({
            updatedAt: 1710000002000,
            uploads: [createUpload()]
          })
        ],
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/tree.png',
            fileUrl: 'file:///workspace/tree.png',
            name: 'tree.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    const generatedButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview generated file tree.png"]'
    )
    const generatedMeta = generatedButton?.querySelector('[data-testid="project-file-meta"]')

    expect(generatedMeta?.className).toContain('flex-col')
    expect(generatedButton?.textContent).toContain('4 KB')
    expect(generatedButton?.textContent).toContain('2 hours ago')
  })

  it('streams image bodies without loading them into base64 preview content', async () => {
    await renderView([
      createSession({
        messages: [
          createMessage({
            uploads: [
              createUpload({
                originalName: 'uploaded_image.png',
                mimeType: 'image/png',
                path: '/uploads/uploaded_image.png'
              })
            ]
          })
        ],
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/typhoon_tracks.png',
            fileUrl: 'file:///workspace/typhoon_tracks.png',
            name: 'typhoon_tracks.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'artifact',
      path: '/workspace/typhoon_tracks.png',
      mimeType: 'image/png'
    })
    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'upload',
      path: '/uploads/uploaded_image.png',
      mimeType: 'image/png'
    })
    expect(
      vi
        .mocked(window.api.artifacts.readPreview)
        .mock.calls.every(([request]) => request.maxBytes === 1)
    ).toBe(true)
    expect(
      vi
        .mocked(window.api.uploads.readPreview)
        .mock.calls.every(([request]) => request.maxBytes === 1)
    ).toBe(true)
    expect(
      container.querySelector('img[alt="Preview of typhoon_tracks.png"]')?.getAttribute('src')
    ).toContain('open-science-preview://')
    expect(
      container.querySelector('img[alt="Preview of uploaded_image.png"]')?.getAttribute('src')
    ).toContain('open-science-preview://')
  })

  it('reacquires an image thumbnail when the file changes at the same path', async () => {
    const createImageSession = (size: number, mtimeMs: number): ChatSession =>
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/changing.png',
            fileUrl: 'file:///workspace/changing.png',
            name: 'changing.png',
            mimeType: 'image/png',
            size,
            mtimeMs
          }
        ]
      })
    await renderView([createImageSession(4096, 1710000002000)])
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const { useSessionStore } = await import('@/stores/session-store')
    await act(async () => {
      useSessionStore.setState({ sessions: [createImageSession(8192, 1710000003000)] })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledTimes(2)
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'resource:/workspace/changing.png'
    })
  })

  it('passes MIME metadata when an extensionless image acquires its resource', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/generated-image',
            fileUrl: 'file:///workspace/generated-image',
            name: 'generated-image',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.previewResources.acquire).toHaveBeenCalledWith({
      source: 'artifact',
      path: '/workspace/generated-image',
      mimeType: 'image/png'
    })
  })

  it('releases a thumbnail resource when the managed image cannot be decoded', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/broken.png',
            fileUrl: 'file:///workspace/broken.png',
            name: 'broken.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      container.querySelector('img[alt="Preview of broken.png"]')?.dispatchEvent(new Event('error'))
      await Promise.resolve()
    })

    expect(container.querySelector('img[alt="Preview of broken.png"]')).toBeNull()
    expect(window.api.previewResources.release).toHaveBeenCalledWith({
      resourceId: 'resource:/workspace/broken.png'
    })
  })

  it('waits until a text thumbnail is near the viewport before reading its first chunk', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn()
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback
        }
      }
    )

    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-csv',
            kind: 'managed-file',
            path: '/workspace/results.csv',
            fileUrl: 'file:///workspace/results.csv',
            name: 'results.csv',
            mimeType: 'text/csv',
            size: 10 * 1024 * 1024,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.artifacts.readPreview).toHaveBeenCalledWith({
      path: '/workspace/results.csv',
      maxBytes: 32768,
      encoding: 'utf8'
    })
  })

  it('badges a file whose source is missing on disk', async () => {
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), {
      code: 'ENOENT'
    })
    ;(window.api.artifacts.readPreview as ReturnType<typeof vi.fn>).mockRejectedValue(enoent)

    // Rendered under StrictMode: the existence probe must survive the dev double-invoke (its first
    // effect pass is canceled), which a synchronous path-claim would break.
    await renderView(
      [
        createSession({
          artifacts: [
            {
              id: 'artifact-gone',
              kind: 'managed-file',
              path: '/workspace/gone.png',
              fileUrl: 'file:///workspace/gone.png',
              name: 'gone.png',
              mimeType: 'image/png',
              size: 4096,
              mtimeMs: 1710000002000
            }
          ]
        })
      ],
      true
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    // The existence probe rejected with ENOENT, so the tile carries the "Missing" tag.
    expect(container.textContent).toContain('Missing')
  })

  it('uses the same text preview capability for generated files and uploads', async () => {
    const treePreview = {
      content: '(sample_a:0.1,sample_b:0.2);',
      encoding: 'utf8' as const,
      size: 30,
      truncated: false
    }
    vi.mocked(window.api.artifacts.readPreview).mockResolvedValue(treePreview)
    vi.mocked(window.api.uploads.readPreview).mockResolvedValue(treePreview)

    await renderView([
      createSession({
        messages: [
          createMessage({
            uploads: [
              createUpload({
                name: 'uploaded.treefile',
                originalName: 'uploaded.treefile',
                path: '/uploads/uploaded.treefile',
                mimeType: undefined,
                size: 30
              })
            ]
          })
        ],
        artifacts: [
          {
            id: 'artifact-tree',
            kind: 'managed-file',
            path: '/workspace/generated.treefile',
            fileUrl: 'file:///workspace/generated.treefile',
            name: 'generated.treefile',
            mimeType: undefined,
            size: 30,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.artifacts.readPreview).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace/generated.treefile', encoding: 'utf8' })
    )
    expect(window.api.uploads.readPreview).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/uploads/uploaded.treefile', encoding: 'utf8' })
    )
    expect(container.querySelectorAll('[data-testid="artifact-skeleton-preview"]')).toHaveLength(2)
  })

  it('retries an uploaded CSV thumbnail after its pending path is finalized', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // The existence probe issues a 1-byte read per file; key the mock on maxBytes so it neither
    // consumes the thumbnail-read sequence below nor badges the pending upload as missing.
    let thumbnailReads = 0
    vi.mocked(window.api.uploads.readPreview).mockImplementation((request) => {
      if (request.maxBytes === 1) {
        return Promise.resolve({ content: '', encoding: 'base64', size: 0, truncated: false })
      }
      thumbnailReads += 1
      if (thumbnailReads === 1) {
        return Promise.reject(new Error('ENOENT: pending upload moved'))
      }
      return Promise.resolve({
        content: 'sample,value\nalpha,1\n',
        encoding: 'utf8',
        size: 21,
        truncated: false
      })
    })

    await renderView([
      createSession({
        messages: [
          createMessage({
            uploads: [
              createUpload({
                sessionId: '.pending',
                name: 'results.csv',
                originalName: 'results.csv',
                path: '/uploads/.pending/results.csv',
                mimeType: 'text/csv',
                size: 21
              })
            ]
          })
        ]
      })
    ])

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const { useSessionStore } = await import('@/stores/session-store')
    await act(async () => {
      useSessionStore.getState().replaceMessageUploads({
        sessionId: 'session-1',
        messageId: 'message-1',
        uploads: [
          createUpload({
            name: 'results.csv',
            originalName: 'results.csv',
            path: '/uploads/session-1/results.csv',
            mimeType: 'text/csv',
            size: 21
          })
        ]
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    // The pending-path read failed with ENOENT, which is an expected unavailable-file error and is
    // deliberately not logged; only the successful retry should surface the finalized content.
    expect(consoleError).not.toHaveBeenCalledWith(
      'Failed to read project file preview',
      expect.any(Error)
    )
    expect(window.api.uploads.readPreview).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/uploads/session-1/results.csv', encoding: 'utf8' })
    )
    expect(container.textContent).toContain('1 rows · 2 columns')
  })

  it('hides a stale thumbnail while a new file version is loading', async () => {
    // Key the mock on maxBytes so the existence probe's 1-byte read never consumes the versioned
    // thumbnail-read sequence (legacy resolves, the next version hangs while loading).
    let thumbnailReads = 0
    vi.mocked(window.api.uploads.readPreview).mockImplementation((request) => {
      if (request.maxBytes === 1) {
        return Promise.resolve({ content: '', encoding: 'base64', size: 0, truncated: false })
      }
      thumbnailReads += 1
      if (thumbnailReads === 1) {
        return Promise.resolve({
          content: 'legacy_column,value\nold,1\n',
          encoding: 'utf8',
          size: 26,
          truncated: false
        })
      }
      return new Promise(() => undefined)
    })

    await renderView([
      createSession({
        messages: [
          createMessage({
            uploads: [
              createUpload({
                name: 'results.csv',
                originalName: 'results.csv',
                path: '/uploads/.pending/results.csv',
                mimeType: 'text/csv',
                size: 26
              })
            ]
          })
        ]
      })
    ])

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('legacy_column')

    const { useSessionStore } = await import('@/stores/session-store')
    await act(async () => {
      useSessionStore.getState().replaceMessageUploads({
        sessionId: 'session-1',
        messageId: 'message-1',
        uploads: [
          createUpload({
            name: 'results.csv',
            originalName: 'results.csv',
            path: '/uploads/session-1/results.csv',
            mimeType: 'text/csv',
            size: 27
          })
        ]
      })
      await Promise.resolve()
    })

    expect(window.api.uploads.readPreview).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/uploads/session-1/results.csv', encoding: 'utf8' })
    )
    expect(container.textContent).not.toContain('legacy_column')
  })

  it('middle-truncates file names in the card style while preserving the extension', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/denovo_design_worklist.csv',
            fileUrl: 'file:///workspace/denovo_design_worklist.csv',
            name: 'denovo_design_worklist.csv',
            mimeType: 'text/csv',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    expect(container.textContent).toContain('denovo_desig...orklist.csv')
    expect(container.textContent).not.toContain('denovo_design_worklist.csv')
  })

  it('uses taller file cards and preview thumbnails', async () => {
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/tree.png',
            fileUrl: 'file:///workspace/tree.png',
            name: 'tree.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    const generatedButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview generated file tree.png"]'
    )
    const previewSurface = generatedButton?.querySelector('[data-testid="project-file-preview"]')

    expect(generatedButton?.className).toContain('h-[128px]')
    expect(previewSurface?.className).toContain('h-[82px]')
  })

  it('opens upload and generated file preview items from their tiles', async () => {
    await renderView([
      createSession({
        id: 'session-1',
        title: 'Generated session',
        messages: [
          createMessage({
            id: 'message-1',
            uploads: [createUpload()]
          })
        ],
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/tree.png',
            fileUrl: 'file:///workspace/tree.png',
            name: 'tree.png',
            mimeType: 'image/png',
            size: 4096,
            mtimeMs: 1710000002000
          }
        ]
      })
    ])

    const uploadButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview uploaded file user upload.png"]'
    )
    const generatedButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview generated file tree.png"]'
    )

    await act(async () => {
      uploadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      generatedButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(usePreviewWorkbenchStore.getState().items).toMatchObject([
      {
        id: 'upload:upload-1',
        source: 'upload',
        name: 'user upload.png'
      },
      {
        id: 'artifact-1',
        name: 'tree.png'
      }
    ])
  })

  it('does not restart a pending thumbnail read when another tile becomes visible', async () => {
    const observed = new Map<Element, IntersectionObserverCallback>()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn((element: Element) => observed.set(element, this.callback))
        unobserve = vi.fn()
        disconnect = vi.fn()

        constructor(private readonly callback: IntersectionObserverCallback) {}
      }
    )
    vi.mocked(window.api.artifacts.readPreview).mockImplementation(
      () => new Promise(() => undefined)
    )
    await renderView([
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: '/workspace/first.txt',
            fileUrl: 'file:///workspace/first.txt',
            name: 'first.txt',
            mimeType: 'text/plain',
            size: 128,
            mtimeMs: 1710000000100
          },
          {
            id: 'artifact-2',
            kind: 'managed-file',
            path: '/workspace/second.txt',
            fileUrl: 'file:///workspace/second.txt',
            name: 'second.txt',
            mimeType: 'text/plain',
            size: 128,
            mtimeMs: 1710000000200
          }
        ]
      })
    ])
    const first = container.querySelector('[aria-label="Preview generated file first.txt"]')
    const second = container.querySelector('[aria-label="Preview generated file second.txt"]')

    await act(async () => {
      observed.get(first as Element)?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
    })
    await act(async () => {
      observed.get(second as Element)?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
      await Promise.resolve()
    })

    const thumbnailReads = vi
      .mocked(window.api.artifacts.readPreview)
      .mock.calls.filter(([request]) => request.maxBytes !== 1)
    expect(thumbnailReads).toHaveLength(2)
    expect(thumbnailReads[0]?.[0]).toEqual(
      expect.objectContaining({ path: '/workspace/first.txt' })
    )
    expect(thumbnailReads[1]?.[0]).toEqual(
      expect.objectContaining({ path: '/workspace/second.txt' })
    )
  })
})
