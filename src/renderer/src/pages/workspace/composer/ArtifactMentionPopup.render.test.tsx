// @vitest-environment jsdom
import { createLiteratureTestRenderer } from '../../../../../../test/renderer/literature'
import { useDesktopRuntimeRecoveryStore } from '../../../stores/desktop-runtime-recovery-store'
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18next } from '@/i18n'
import { useNavigationStore } from '@/stores/navigation-store'
import type {
  LiteratureCollectionView,
  LiteratureItemView
} from '@aipoch/literature-library/contracts'
import type { ProjectFileItem } from '../../../../../shared/project-files'
import { ArtifactMentionPopup } from './ArtifactMentionPopup'

const { createRoot } = createLiteratureTestRenderer({
  get api() {
    return window.api
  },
  onRecovered: () => () => {}
})

let container: HTMLDivElement
let root: Root

const defaultProjectFiles: ProjectFileItem[] = [
  {
    id: 'upload:up-1',
    source: 'upload',
    sourceFileId: 'up-1',
    sourceVersionId: 'up-1-v1',
    projectId: 'default',
    sessionId: 'session-1',
    name: 'sequence.csv',
    path: 'upload-version:default/session-1/up-1-v1',
    mimeType: 'text/csv',
    size: 2048,
    sortAtMs: 1710000001000
  },
  {
    id: 'art-1',
    source: 'artifact',
    sourceFileId: 'art-1',
    sourceVersionId: 'art-1-v1',
    projectId: 'default',
    sessionId: 'session-1',
    name: 'report.pdf',
    path: 'artifact-version:default/session-1/art-1/art-1-v1',
    mimeType: 'application/pdf',
    size: 4096,
    sortAtMs: 1710000002000
  }
]

const libraryPdf: LiteratureItemView = {
  id: 'literature-item-1',
  item: {
    itemType: 'journalArticle',
    title: 'Corrective Retrieval Augmented Generation',
    abstract: '',
    issuedText: '2024',
    issuedYear: 2024,
    containerTitle: 'arXiv',
    shortTitle: 'CRAG',
    language: 'en',
    rights: '',
    url: '',
    extra: '',
    typeFields: {},
    creators: [
      {
        nameMode: 'person',
        givenName: 'Shi-Qi',
        familyName: 'Yan',
        creatorType: 'author'
      }
    ],
    identifiers: []
  },
  attachments: [
    {
      id: 'literature-attachment-1',
      kind: 'fullText',
      title: '',
      sortOrder: 0,
      versions: [
        {
          id: 'literature-version-1',
          versionNumber: 1,
          filename: 'crag.pdf',
          contentType: 'application/pdf',
          sizeBytes: 629,
          checksum: 'a'.repeat(64),
          pageCount: 14,
          createdAt: 2
        }
      ],
      createdAt: 2,
      updatedAt: 2
    }
  ],
  projectIds: [],
  collectionIds: [],
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 2
}

beforeEach(() => {
  useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', epoch: 0, closing: false })
  // Non-image rows never read previews, but stub the api so an accidental read never throws.
  ;(window as unknown as { api: unknown }).api = {
    uploads: {
      readPreview: vi.fn().mockResolvedValue({ content: '', encoding: 'base64', size: 0 })
    },
    artifacts: {
      readPreview: vi.fn().mockResolvedValue({ content: '', encoding: 'base64', size: 0 })
    },
    projectFiles: {
      listFiles: vi.fn().mockResolvedValue({
        items: defaultProjectFiles,
        totalCount: defaultProjectFiles.length
      })
    },
    managedFileVersions: {
      inspect: vi.fn().mockImplementation(async (request) => ({
        ok: true,
        value: {
          source: request.source,
          projectId: request.projectId,
          fileId: request.fileId,
          sessionId: 'session-1',
          displayName: request.source === 'upload' ? 'sequence.csv' : 'report.pdf',
          headVersionId: `${request.fileId}-v2`,
          selectedVersionId: `${request.fileId}-v2`,
          versions: [
            {
              id: `${request.fileId}-v2`,
              source: request.source,
              fileId: request.fileId,
              versionNumber: 2,
              displayName: request.source === 'upload' ? 'sequence.csv' : 'report.pdf',
              originKind: request.source === 'upload' ? 'user_upload' : 'agent_generated',
              basedOnVersionId: null,
              contentType: request.source === 'upload' ? 'text/csv' : 'application/pdf',
              sizeBytes: 2048,
              checksum: '2'.repeat(64),
              createdAt: '2026-08-14T00:00:00.000Z'
            }
          ],
          canEdit: false,
          canDiff: false
        }
      }))
    },
    literature: {
      search: vi.fn().mockResolvedValue({ entries: [] })
    }
  }
  useNavigationStore.setState({ activeProjectId: 'default' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  void i18next.changeLanguage('en')
})

const options = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))

const pressKey = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init
  })
  act(() => {
    document.dispatchEvent(event)
  })
  return event
}

const flushSelection = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const renderPopup = async ({
  query = '',
  onSelect = vi.fn(),
  onClose = vi.fn()
}: {
  query?: string
  onSelect?: (value: unknown) => void
  onClose?: () => void
} = {}): Promise<void> => {
  await act(async () => {
    root.render(<ArtifactMentionPopup query={query} onSelect={onSelect} onClose={onClose} />)
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ArtifactMentionPopup', () => {
  it('bounds thumbnail reads and drops queued work when the popup closes', async () => {
    const files = Array.from({ length: 230 }, (_, index) => ({
      ...defaultProjectFiles[1],
      id: `image-${index}`,
      path: `artifact-version:default/session-1/image-${index}/v1`,
      name: `image-${index}.png`,
      mimeType: 'image/png'
    }))
    window.api.projectFiles.listFiles = vi
      .fn()
      .mockResolvedValue({ items: files, totalCount: files.length })
    let finish!: (result: {
      content: string
      encoding: 'base64'
      size: number
      truncated: boolean
    }) => void
    const pending = new Promise<{
      content: string
      encoding: 'base64'
      size: number
      truncated: boolean
    }>((resolve) => {
      finish = resolve
    })
    const read = vi.fn().mockReturnValue(pending)
    window.api.artifacts.readPreview = read
    await renderPopup()
    expect(options()).toHaveLength(230)
    expect(read).toHaveBeenCalledTimes(4)
    await act(async () => {
      root.render(null)
    })
    await act(async () => {
      finish({ content: '', encoding: 'base64', size: 0, truncated: false })
    })
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('retains physical read slots across close and reopen and discards the closed popup queue', async () => {
    const files = Array.from({ length: 8 }, (_, index) => ({
      ...defaultProjectFiles[1],
      id: `reopen-image-${index}`,
      path: `reopen-${index}`,
      name: `reopen-${index}.png`,
      mimeType: 'image/png'
    }))
    window.api.projectFiles.listFiles = vi
      .fn()
      .mockResolvedValue({ items: files, totalCount: files.length })
    let finish!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      finish = resolve
    })
    const read = vi.fn().mockReturnValue(pending)
    window.api.artifacts.readPreview = read
    await renderPopup()
    expect(read).toHaveBeenCalledTimes(4)
    await act(async () => root.render(null))
    await renderPopup()
    expect(read).toHaveBeenCalledTimes(4)
    read.mockResolvedValue({ content: 'FRESH', encoding: 'base64', size: 3, truncated: false })
    await act(async () => finish({ content: 'OLD', encoding: 'base64', size: 3, truncated: false }))
    // Four old active reads plus eight new visible rows; the four old queued reads never start.
    expect(read).toHaveBeenCalledTimes(12)
    expect(container.innerHTML).not.toContain('base64,OLD')
    expect(container.innerHTML).toContain('base64,FRESH')
  })

  it('ignores old thumbnails across recovery and keeps one four-read popup queue', async () => {
    const files = Array.from({ length: 8 }, (_, index) => ({
      ...defaultProjectFiles[1],
      id: `recovery-image-${index}`,
      path: `image-${index}`,
      name: `image-${index}.png`,
      mimeType: 'image/png'
    }))
    window.api.projectFiles.listFiles = vi
      .fn()
      .mockResolvedValue({ items: files, totalCount: files.length })
    let finish!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      finish = resolve
    })
    const read = vi.fn().mockReturnValue(pending)
    window.api.artifacts.readPreview = read
    await renderPopup()
    expect(read).toHaveBeenCalledTimes(4)
    await act(async () => {
      useDesktopRuntimeRecoveryStore.setState({ phase: 'disconnected', epoch: 1 })
    })
    await act(async () => {
      useDesktopRuntimeRecoveryStore.setState({ phase: 'connected' })
    })
    expect(read).toHaveBeenCalledTimes(4)
    read.mockResolvedValue({ content: 'NEW', encoding: 'base64', size: 3, truncated: false })
    await act(async () => {
      finish({ content: 'OLD', encoding: 'base64', size: 3, truncated: false })
    })
    expect(read).toHaveBeenCalledTimes(12)
    expect(container.innerHTML).not.toContain('base64,OLD')
    expect(container.innerHTML).toContain('base64,NEW')
    expect(read.mock.calls.every(([request]) => request.maxBytes === 256 * 1024)).toBe(true)
  })

  it('only reads thumbnails after their rows enter the viewport', async () => {
    let notify!: IntersectionObserverCallback
    const observed: Element[] = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          notify = callback
        }
        observe(element: Element): void {
          observed.push(element)
        }
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    const files = Array.from({ length: 20 }, (_, index) => ({
      ...defaultProjectFiles[1],
      id: `image-${index}`,
      path: `image-${index}`,
      name: `image-${index}.png`,
      mimeType: 'image/png'
    }))
    window.api.projectFiles.listFiles = vi
      .fn()
      .mockResolvedValue({ items: files, totalCount: files.length })
    await renderPopup()
    expect(observed).toHaveLength(20)
    expect(window.api.artifacts.readPreview).not.toHaveBeenCalled()
    await act(async () =>
      notify(
        [{ target: observed[0], isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    )
    expect(window.api.artifacts.readPreview).toHaveBeenCalledExactlyOnceWith({
      path: 'image-0',
      maxBytes: 256 * 1024,
      encoding: 'base64'
    })
    expect(container.querySelectorAll('img')).toHaveLength(1)
  })

  it('drops filtered thumbnail requests while allowing the retained row to load', async () => {
    const files = Array.from({ length: 10 }, (_, index) => ({
      ...defaultProjectFiles[1],
      id: `image-${index}`,
      path: `image-${index}`,
      name: index === 9 ? 'retained.png' : `image-${index}.png`,
      mimeType: 'image/png'
    }))
    window.api.projectFiles.listFiles = vi
      .fn()
      .mockResolvedValue({ items: files, totalCount: files.length })
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const read = vi.fn(async () => {
      await pending
      return { content: '', encoding: 'base64' as const, size: 0, truncated: false }
    })
    window.api.artifacts.readPreview = read
    await renderPopup()
    expect(read).toHaveBeenCalledTimes(4)
    await renderPopup({ query: 'retained' })
    expect(options()).toHaveLength(1)
    await act(async () => finish())
    expect(read).toHaveBeenCalledTimes(5)
    expect(read).toHaveBeenLastCalledWith({
      path: 'image-9',
      maxBytes: 256 * 1024,
      encoding: 'base64'
    })
    expect(container.querySelector('img')).not.toBeNull()
  })

  it('does not decode a truncated file prefix as a complete thumbnail', async () => {
    const file = {
      ...defaultProjectFiles[1],
      name: 'large.png',
      mimeType: 'image/png',
      size: 1024 * 1024
    }
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({ items: [file], totalCount: 1 })
    window.api.artifacts.readPreview = vi.fn().mockResolvedValue({
      content: 'cGFydGlhbA==',
      encoding: 'base64',
      size: file.size,
      truncated: true
    })
    await renderPopup()
    expect(container.querySelector('img')).toBeNull()
  })

  it('falls back to the image glyph when a thumbnail cannot be decoded', async () => {
    const file = { ...defaultProjectFiles[1], name: 'broken.png', mimeType: 'image/png' }
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({ items: [file], totalCount: 1 })
    window.api.artifacts.readPreview = vi.fn().mockResolvedValue({
      content: 'bm90IGFuIGltYWdl',
      encoding: 'base64',
      size: 12,
      truncated: false
    })
    await renderPopup()
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    act(() => img!.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBeNull()
  })

  it.each(['click', 'Enter'])(
    'rejects prior-project Literature suggestions via %s while the next search is pending',
    async (selection) => {
      const onSelect = vi.fn()
      window.api.literature.search = vi.fn().mockImplementation((request) => {
        if (request.scope === 'collections') return Promise.resolve({ entries: [] })
        if (request.projectId === 'project-b') return new Promise(() => undefined)
        return Promise.resolve({ entries: [libraryPdf] })
      })
      await renderPopup({ query: 'Corrective', onSelect })
      await vi.waitFor(() =>
        expect(options().some((row) => row.textContent?.includes('Corrective'))).toBe(true)
      )
      await act(async () => useNavigationStore.setState({ activeProjectId: 'project-b' }))
      if (selection === 'click')
        act(() =>
          options()
            .find((row) => row.textContent?.includes('Corrective'))
            ?.click()
        )
      else pressKey('Enter')
      expect(onSelect).not.toHaveBeenCalled()
      expect(options().some((row) => row.textContent?.includes('Corrective'))).toBe(false)
    }
  )

  it('reports failed Collection suggestions instead of an empty result', async () => {
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({ items: [], totalCount: 0 })
    window.api.literature.search = vi.fn().mockImplementation(async (request) => {
      if (request.scope === 'collections') throw new Error('Collection search unavailable')
      return { entries: [] }
    })
    await renderPopup({ query: 'Unique' })
    await vi.waitFor(() => expect(window.api.literature.search).toHaveBeenCalled())
    await flushSelection()
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('No artifacts yet')
  })

  it('reports failed Literature suggestions alongside healthy project files', async () => {
    window.api.literature.search = vi.fn().mockImplementation(async (request) => {
      if (request.scope === 'collections') return { entries: [] }
      throw new Error('Literature search unavailable')
    })
    await renderPopup({ query: 'seq' })
    await vi.waitFor(() => expect(window.api.literature.search).toHaveBeenCalled())
    await flushSelection()
    expect(options().some((row) => row.textContent?.includes('sequence.csv'))).toBe(true)
    expect(document.body.querySelector('[role="alert"]')?.textContent ?? '').toContain(
      'Literature could not be loaded.'
    )
  })

  it('retries only the failed source while keeping healthy options available', async () => {
    let fail = true
    window.api.literature.search = vi.fn().mockImplementation(async (request) => {
      if (request.scope === 'collections') {
        if (fail) throw new Error('Collection search unavailable')
        return {
          entries: [
            {
              id: 'collection-retry',
              name: 'Corrective collection',
              description: '',
              itemCount: 1,
              createdAt: 1,
              updatedAt: 1
            }
          ]
        }
      }
      return { entries: [libraryPdf] }
    })
    await renderPopup({ query: 'Corrective' })
    await vi.waitFor(() =>
      expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
        'Collections could not be loaded.'
      )
    )
    expect(options().some((row) => row.textContent?.includes('Corrective Retrieval'))).toBe(true)
    const count = vi
      .mocked(window.api.literature.search)
      .mock.calls.filter(([request]) => request.scope !== 'collections').length
    fail = false
    act(() => document.body.querySelector<HTMLButtonElement>('[role="alert"] button')?.click())
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
    expect(options().some((row) => row.textContent?.includes('Corrective Retrieval'))).toBe(true)
    await vi.waitFor(() =>
      expect(options().some((row) => row.textContent?.includes('Corrective collection'))).toBe(true)
    )
    expect(
      vi
        .mocked(window.api.literature.search)
        .mock.calls.filter(([request]) => request.scope !== 'collections')
    ).toHaveLength(count)
  })

  it('accepts fresh next-project results after rejecting the previous project', async () => {
    const onSelect = vi.fn()
    window.api.literature.search = vi.fn().mockImplementation(async (request) => ({
      entries:
        request.scope === 'collections'
          ? []
          : [{ ...libraryPdf, id: request.projectId === 'project-b' ? 'item-b' : 'item-a' }]
    }))
    await renderPopup({ query: 'Corrective', onSelect })
    await vi.waitFor(() =>
      expect(options().some((row) => row.textContent?.includes('Corrective'))).toBe(true)
    )
    await act(async () => useNavigationStore.setState({ activeProjectId: 'project-b' }))
    expect(options().some((row) => row.textContent?.includes('Corrective'))).toBe(false)
    await vi.waitFor(() =>
      expect(options().some((row) => row.textContent?.includes('Corrective'))).toBe(true)
    )
    pressKey('Enter')
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'item-b' }))
  })

  it('owns Enter while project files are still loading', () => {
    window.api.projectFiles.listFiles = vi.fn(
      () => new Promise(() => undefined)
    ) as typeof window.api.projectFiles.listFiles
    act(() => {
      root.render(<ArtifactMentionPopup query="seq" onSelect={vi.fn()} onClose={vi.fn()} />)
    })
    const loadingStatus = document.body.querySelector('[role="status"]')
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull()
    expect(loadingStatus?.textContent).toContain('Loading project files')
    expect(loadingStatus?.getAttribute('aria-live')).toBe('polite')
    expect(loadingStatus?.getAttribute('aria-atomic')).toBe('true')
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true
    })

    act(() => {
      document.dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
    expect(pressKey('Tab').defaultPrevented).toBe(false)
  })

  it('renders both sections with rows and tags', async () => {
    await renderPopup()

    expect(window.api.projectFiles.listFiles).toHaveBeenCalledWith({
      projectId: 'default',
      collection: { kind: 'all' },
      limit: 100
    })
    expect(options()).toHaveLength(2)
    const text = document.body.textContent ?? ''
    expect(text).toContain('User uploads')
    expect(text).toContain('Other artifacts')
    expect(text).toContain('sequence.csv')
    expect(text).toContain('report.pdf')
    // Section tags distinguish upload vs generated output.
    expect(text).toContain('upload')
    expect(text).toContain('output')
  })

  it('offers a Literature record as an immutable bibliographic mention with optional PDF', async () => {
    const onSelect = vi.fn()
    window.api.literature.search = vi.fn().mockResolvedValue({ entries: [libraryPdf] })

    await renderPopup({ query: 'Corrective', onSelect })
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Corrective Retrieval Augmented Generation')
    )

    const libraryRow = options().find((option) =>
      option.textContent?.includes('Corrective Retrieval Augmented Generation')
    )
    expect(libraryRow?.textContent).toContain('Yan, Shi-Qi · 2024')

    act(() => libraryRow?.click())
    expect(onSelect).toHaveBeenCalledWith({
      type: 'literature',
      itemId: 'literature-item-1',
      metadataRevision: 1,
      item: libraryPdf.item,
      attachmentVersionId: 'literature-version-1'
    })
  })

  it('offers a metadata-only Literature record without pretending it is a file', async () => {
    const onSelect = vi.fn()
    window.api.literature.search = vi.fn().mockResolvedValue({
      entries: [{ ...libraryPdf, id: 'metadata-only', attachments: [] }]
    })

    await renderPopup({ query: 'Corrective', onSelect })
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Corrective Retrieval Augmented Generation')
    )
    act(() =>
      options()
        .find((option) => option.textContent?.includes('Corrective'))
        ?.click()
    )

    expect(onSelect).toHaveBeenCalledWith({
      type: 'literature',
      itemId: 'metadata-only',
      metadataRevision: 1,
      item: libraryPdf.item
    })
  })

  it('offers explicit current-Project Library and Collection retrieval scopes', async () => {
    const onSelect = vi.fn()
    window.api.literature.search = vi.fn().mockImplementation(async (request) => ({
      entries:
        request.scope === 'collections'
          ? [
              {
                id: 'collection-1',
                revision: 1,
                name: 'TP53 evidence',
                description: '',
                itemCount: 27,
                createdAt: 1,
                updatedAt: 1
              } satisfies LiteratureCollectionView
            ]
          : []
    }))

    await renderPopup({ query: 'Library', onSelect })
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('References linked to this project.')
    )
    act(() =>
      options()
        .find((option) => option.textContent?.includes('References linked to this project.'))
        ?.click()
    )
    expect(onSelect).toHaveBeenLastCalledWith({
      type: 'literature-scope',
      scope: 'project'
    })

    await renderPopup({ query: 'TP53', onSelect })
    await vi.waitFor(() => expect(document.body.textContent).toContain('TP53 evidence'))
    act(() =>
      options()
        .find((option) => option.textContent?.includes('TP53 evidence'))
        ?.click()
    )
    expect(onSelect).toHaveBeenLastCalledWith({
      type: 'literature-scope',
      scope: 'collection',
      collectionId: 'collection-1',
      name: 'TP53 evidence'
    })
  })

  it('keeps Literature records available when Collection suggestions fail', async () => {
    window.api.literature.search = vi.fn().mockImplementation(async (request) => {
      if (request.scope === 'collections') throw new Error('Collection search unavailable')
      return { entries: [libraryPdf] }
    })

    await renderPopup({ query: 'Corrective' })

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Corrective Retrieval Augmented Generation')
    )
    expect(document.body.textContent).not.toContain('Could not load library references.')
  })

  it('uses the preview-tab abbreviation for a long filename while preserving its extension', async () => {
    const longName = 'very_long_experiment_analysis_result_2025.csv'
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({
      items: [
        {
          ...defaultProjectFiles[1],
          id: 'long-artifact',
          sourceFileId: 'long-artifact',
          sourceVersionId: 'long-artifact',
          name: longName
        }
      ],
      totalCount: 1
    })

    await renderPopup()

    expect(options()[0]?.querySelector('[data-testid="file-name-tail"]')?.textContent).toBe('_2025')
  })

  it('loads every Project Files page before presenting suggestions', async () => {
    window.api.projectFiles.listFiles = vi
      .fn()
      .mockResolvedValueOnce({
        items: [defaultProjectFiles[0]],
        totalCount: 2,
        nextCursor: 'next-page'
      })
      .mockResolvedValueOnce({ items: [defaultProjectFiles[1]], totalCount: 2 })

    await renderPopup()

    expect(options()).toHaveLength(2)
    expect(window.api.projectFiles.listFiles).toHaveBeenNthCalledWith(2, {
      projectId: 'default',
      collection: { kind: 'all' },
      cursor: 'next-page',
      limit: 100
    })
  })

  it('shows a Project Files query failure instead of a false empty state', async () => {
    window.api.projectFiles.listFiles = vi.fn().mockRejectedValue(new Error('database unavailable'))

    await renderPopup()

    expect(options()).toHaveLength(0)
    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Could not load project files')
    expect(alert?.getAttribute('aria-live')).toBe('assertive')
    expect(alert?.getAttribute('aria-atomic')).toBe('true')
    expect(document.body.textContent).toContain('Could not load project files')
    expect(document.body.textContent).not.toContain('No artifacts yet')
  })

  it('rejects a repeated Project Files cursor', async () => {
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({
      items: [],
      totalCount: 1,
      nextCursor: 'repeated-page'
    })

    await renderPopup()

    expect(window.api.projectFiles.listFiles).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('Could not load project files')
  })

  it('shows an upload indexed from another session in the same project', async () => {
    const onSelect = vi.fn()
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'upload:shared-csv',
          source: 'upload',
          sourceFileId: 'shared-csv',
          sourceVersionId: 'shared-csv-v1',
          projectId: 'default',
          sessionId: 'other-session',
          name: 'shared-data.csv',
          path: 'upload-version:default/other-session/shared-csv-v1',
          mimeType: 'text/csv',
          size: 2048,
          sortAtMs: 1710000003000
        }
      ],
      totalCount: 1
    })

    await renderPopup({ onSelect })

    expect(options()).toHaveLength(1)
    expect(document.body.textContent).toContain('shared-data.csv')
    pressKey('Enter')
    await flushSelection()
    expect(onSelect).toHaveBeenCalledWith({
      id: 'upload:shared-csv',
      sourceFileId: 'shared-csv',
      name: 'sequence.csv',
      path: 'upload-version:default/other-session/shared-csv-v1',
      source: 'upload',
      mimeType: 'text/csv',
      versionId: 'shared-csv-v2'
    })
  })

  it('uses the Project Files artifact projection instead of Session metadata', async () => {
    const onSelect = vi.fn()
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'artifact-lineage-1',
          source: 'artifact',
          sourceFileId: 'artifact-lineage-1',
          sourceVersionId: 'artifact-version-2',
          projectId: 'default',
          sessionId: 'other-session',
          name: 'other-session-result.pdf',
          path: 'artifact-version:default/other-session/artifact-lineage-1/artifact-version-2',
          mimeType: 'application/pdf',
          size: 4096,
          sortAtMs: 1710000004000
        }
      ],
      totalCount: 1
    })

    await renderPopup({ onSelect })

    expect(document.body.textContent).toContain('other-session-result.pdf')
    pressKey('Enter')
    await flushSelection()
    expect(onSelect).toHaveBeenCalledWith({
      id: 'artifact-lineage-1',
      sourceFileId: 'artifact-lineage-1',
      name: 'report.pdf',
      path: 'artifact-version:default/other-session/artifact-lineage-1/artifact-version-2',
      source: 'artifact',
      mimeType: 'application/pdf',
      versionId: 'artifact-lineage-1-v2'
    })
  })

  it('filters rows by a case-insensitive filename query', async () => {
    await renderPopup({ query: 'REPORT' })

    const rendered = options()
    expect(rendered).toHaveLength(1)
    expect(document.body.textContent).toContain('report.pdf')
    expect(document.body.textContent).not.toContain('sequence.csv')
  })

  it('selects the highlighted row on Enter with the picked reference shape', async () => {
    const onSelect = vi.fn()
    await renderPopup({ onSelect })

    // First row is the upload.
    pressKey('Enter')
    await flushSelection()
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'upload:up-1',
        name: 'sequence.csv',
        path: 'upload-version:default/session-1/up-1-v1',
        source: 'upload'
      })
    )
  })

  it('selects the highlighted row on plain Tab but preserves Shift+Tab navigation', async () => {
    const onSelect = vi.fn()
    await renderPopup({ onSelect })

    pressKey('ArrowDown')
    const tabEvent = pressKey('Tab')
    const shiftTabEvent = pressKey('Tab', { shiftKey: true })
    await flushSelection()

    expect(tabEvent.defaultPrevented).toBe(true)
    expect(shiftTabEvent.defaultPrevented).toBe(false)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'art-1' }))
    expect(document.body.textContent).toContain('Enter / Tab select')
  })

  it('selects an artifact row on click', async () => {
    const onSelect = vi.fn()
    await renderPopup({ onSelect })

    const artifactRow = options()[1]
    act(() => artifactRow.click())
    await flushSelection()
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'art-1',
        name: 'report.pdf',
        path: 'artifact-version:default/session-1/art-1/art-1-v1',
        source: 'artifact'
      })
    )
  })

  it('resolves the current DB head when a stale suggestion is selected', async () => {
    const onSelect = vi.fn()
    await renderPopup({ onSelect })

    await act(async () => {
      options()[0]?.click()
      await Promise.resolve()
    })

    expect(window.api.managedFileVersions.inspect).toHaveBeenCalledWith({
      source: 'upload',
      projectId: 'default',
      fileId: 'up-1'
    })
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFileId: 'up-1',
        versionId: 'up-1-v2',
        name: 'sequence.csv'
      })
    )
  })

  it('keeps the popup open without inserting when head resolution fails', async () => {
    const onSelect = vi.fn()
    window.api.managedFileVersions.inspect = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'VERSION_NOT_FOUND', message: 'File head unavailable.' }
    })
    await renderPopup({ onSelect })
    await act(async () => i18next.changeLanguage('zh-Hans'))

    await act(async () => {
      options()[0]?.click()
      await Promise.resolve()
    })

    expect(onSelect).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('无法解析文件版本。')
    expect(document.body.textContent).not.toContain('File head unavailable.')
    expect(options()).toHaveLength(2)
  })

  it('shows an empty state when the project has no artifacts', async () => {
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({ items: [], totalCount: 0 })
    await renderPopup()

    await vi.waitFor(() => expect(document.body.textContent).toContain('No artifacts yet'))
    expect(options()).toHaveLength(0)
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    await renderPopup({ onClose })

    pressKey('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('matches a filename by fuzzy subsequence a substring would miss', async () => {
    await renderPopup({ query: 'rpt' })

    // "rpt" is an ordered subsequence of "report.pdf" but not a substring, and matches no upload.
    const rendered = options()
    expect(rendered).toHaveLength(1)
    expect(rendered[0].textContent).toContain('report.pdf')
    expect(document.body.textContent).not.toContain('sequence.csv')
  })

  it('highlights the matched characters in the filename', async () => {
    await renderPopup({ query: 'report' })

    const marks = Array.from(document.body.querySelectorAll('mark'))
    expect(
      marks
        .map((mark) => mark.textContent)
        .join('')
        .toLowerCase()
    ).toContain('report')
  })

  it('ranks a closer fuzzy match first within a section', async () => {
    // Two outputs in the same section: a prefix match must outrank a later word-boundary match.
    window.api.projectFiles.listFiles = vi.fn().mockResolvedValue({
      items: [
        {
          ...defaultProjectFiles[1],
          id: 'art-late',
          sourceFileId: 'art-late',
          sourceVersionId: 'art-late',
          name: 'final-report.pdf'
        },
        {
          ...defaultProjectFiles[1],
          id: 'art-early',
          sourceFileId: 'art-early',
          sourceVersionId: 'art-early',
          name: 'report.pdf'
        }
      ],
      totalCount: 2
    })

    await renderPopup({ query: 'report' })

    const rendered = options()
    expect(rendered).toHaveLength(2)
    // "report.pdf" (prefix) ranks ahead of "final-report.pdf" (match after the dash).
    expect(rendered[0].textContent).not.toContain('final')
    expect(rendered[1].textContent).toContain('final-report.pdf')
  })
})
